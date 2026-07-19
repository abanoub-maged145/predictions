// ============================================================
// المُتنبئ — التطبيق الرئيسي (v2)
// ============================================================

const API = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const API_STANDINGS = 'https://site.api.espn.com/apis/v2/sports/soccer';

const LEAGUES = [
  { code: 'eng.1', name: 'الدوري الإنجليزي' },
  { code: 'esp.1', name: 'الدوري الإسباني' },
  { code: 'ita.1', name: 'الدوري الإيطالي' },
  { code: 'ger.1', name: 'الدوري الألماني' },
  { code: 'fra.1', name: 'الدوري الفرنسي' },
  { code: 'uefa.champions', name: 'دوري أبطال أوروبا' },
  { code: 'uefa.europa', name: 'الدوري الأوروبي' },
  { code: 'ksa.1', name: 'الدوري السعودي' },
  { code: 'caf.champions', name: 'دوري أبطال أفريقيا' },
  { code: 'caf.confed', name: 'الكونفدرالية الأفريقية' },
  { code: 'usa.1', name: 'الدوري الأمريكي MLS' },
  { code: 'fifa.world', name: 'كأس العالم' },
  { code: 'uefa.euro', name: 'يورو' },
  { code: 'uefa.nations', name: 'دوري الأمم الأوروبية' },
  { code: 'fifa.friendly', name: 'ودية منتخبات' },
  { code: 'caf.nations', name: 'كأس أمم أفريقيا' },
  { code: 'conmebol.america', name: 'كوبا أمريكا' },
];
const LEAGUE_NAME = Object.fromEntries(LEAGUES.map(l => [l.code, l.name]));

const LEAGUE_BY_ABBR = {
  'MLS': 'usa.1', 'Prem': 'eng.1', 'EPL': 'eng.1', 'LALIGA': 'esp.1', 'LaLiga': 'esp.1',
  'Serie A': 'ita.1', 'Bund': 'ger.1', 'Ligue 1': 'fra.1', 'UCL': 'uefa.champions', 'UEL': 'uefa.europa',
};

const state = {
  date: new Date(),
  mode: 'day',          // day = ماتشات يوم معين | league = جولات دوري كامل
  leagueView: null,     // كود الدوري المختار في وضع الدوري
  matches: [],
  analysisCache: {},
  summaryCache: {},
  standingsCache: {},
  currentView: 'matches',
  leagueFilter: null,
  bulkRunning: false,
};

// ---------- أدوات ----------
const $ = sel => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const fmtDateKey = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const fmtDateISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = iso => new Date(iso).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' });
const fmtDayName = d => d.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });

async function fetchJSON(url, { cache = true } = {}) {
  if (cache && state.summaryCache[url]) return state.summaryCache[url];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (cache) state.summaryCache[url] = data;
  return data;
}

// ---------- التخزين المحلي ----------
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
};
const STANDINGS_KEY = 'predictor_standings_v1'; // كاش عام مشترك — مجرد بيانات ترتيب

// كل مستخدم ليه مساحة تخزين خاصة ببصمة الباسورد بتاعه — نشاط حد مش بيظهر لحد تاني
// DATA_NS ثابت حتى لو طريقة التحقق اتغيرت (ترقية PBKDF2) عشان البيانات متضيعش
const nsKey = base => `${base}_${(window.DATA_NS || window.AUTH_HASH || 'anon').slice(0, 10)}`;
const slipsKey = () => nsKey('predictor_slips_v1');
const autologKey = () => nsKey('predictor_autolog_v1');
const learnedKey = () => nsKey('predictor_learned_v1');

const loadSlips = () => store.get(slipsKey(), []);
const saveSlips = s => store.set(slipsKey(), s);
const loadLearned = () => store.get(learnedKey(), { weights: null, buckets: {}, pillars: {}, settled: 0 });

// الفرق المفضلة — ماتشاتها بتتثبت في أول الصفحة
const favsKey = () => nsKey('predictor_favs_v1');
const loadFavs = () => store.get(favsKey(), []);
const isFav = id => loadFavs().some(f => String(f.id) === String(id));
function toggleFav(team) {
  let favs = loadFavs();
  if (isFav(team.id)) favs = favs.filter(f => String(f.id) !== String(team.id));
  else favs.push({ id: String(team.id), name: team.name, logo: team.logo || null });
  store.set(favsKey(), favs);
  toast(isFav(team.id) ? `⭐ ${team.name} اتضاف لفرقك` : `اتشال ${team.name} من فرقك`);
}

// ترحيل بيانات النسخة القديمة (قبل الفصل بين المستخدمين) لحساب الأدمن — مرة واحدة
function migrateLegacyStorage() {
  if (window.AUTH_ROLE !== 'admin') return;
  for (const base of ['predictor_slips_v1', 'predictor_autolog_v1', 'predictor_learned_v1']) {
    const legacy = localStorage.getItem(base);
    if (legacy && !localStorage.getItem(nsKey(base))) localStorage.setItem(nsKey(base), legacy);
    if (legacy) localStorage.removeItem(base);
  }
}

// معاملات المعايرة من سجل الدقة: لو ثقة 80% بتصيب 65% فعلاً → نزّلها
// معايرة عامة + معايرة لكل سوق لوحده (انحياز خط الأهداف غير انحياز النتيجة)
function calibFactors() {
  const learned = loadLearned();
  const mids = { '50': 55, '60': 65, '70': 75, '80': 85, '90': 92 };
  const factorize = buckets => {
    const out = {};
    for (const [b, mid] of Object.entries(mids)) {
      const s = buckets?.[b];
      if (s && s.total >= 8) {
        out[b] = Math.max(0.75, Math.min(1.12, (s.hit / s.total) * 100 / mid));
      }
    }
    return Object.keys(out).length ? out : null;
  };
  const _all = factorize(learned.buckets);
  const byMkt = {};
  for (const [mkt, buckets] of Object.entries(learned.bucketsMkt || {})) {
    const f = factorize(buckets);
    if (f) byMkt[mkt] = f;
  }
  if (!_all && !Object.keys(byMkt).length) return null;
  return { _all, byMkt };
}

// ---------- جدول الترتيب (قوة الخصوم) ----------
async function getOppStrength(league) {
  if (state.standingsCache[league]) return state.standingsCache[league];
  const cached = store.get(STANDINGS_KEY, {});
  if (cached[league] && Date.now() - cached[league].ts < 12 * 3600 * 1000) {
    state.standingsCache[league] = cached[league].map;
    return cached[league].map;
  }
  let map = {};
  try {
    const data = await fetchJSON(`${API_STANDINGS}/${league}/standings`);
    const groups = data.children || [];
    for (const grp of groups) {
      const entries = grp.standings?.entries || [];
      const n = entries.length;
      for (const e of entries) {
        const rank = e.stats?.find(s => s.name === 'rank')?.value;
        if (e.team?.id && rank && n > 1) map[String(e.team.id)] = 1 - (rank - 1) / (n - 1);
      }
    }
  } catch { map = {}; }
  state.standingsCache[league] = map;
  cached[league] = { ts: Date.now(), map };
  store.set(STANDINGS_KEY, cached);
  return map;
}

// ---------- تقييم Elo محلي ----------
// بيتبني تلقائياً من كل نتيجة الموقع بيشوفها — مقياس قوة موحد لكل الفرق
// في كل البطولات (بيحل مشكلة مقارنة فرق من دوريات مختلفة).
// مشترك بين المستخدمين لأنه بيانات موضوعية، وبيتزامن مع النسخ الاحتياطية.
const ELO_KEY = 'predictor_elo_v1';
const clampN = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const EloDB = {
  d: null,
  load() { if (!this.d) this.d = store.get(ELO_KEY, { teams: {}, done: {}, order: [] }); return this.d; },
  save() { store.set(ELO_KEY, this.d); },
  get(id) { return this.load().teams[String(id)] || { r: 1500, n: 0 }; },
  // قوة من 0 لـ 1 حوالين 0.5 — null لو الفريق لسه ملوش تاريخ كفاية
  strength01(id) {
    const t = this.get(id);
    return t.n >= 5 ? 1 / (1 + Math.pow(10, -(t.r - 1500) / 300)) : null;
  },
  record(m) {
    const d = this.load();
    if (d.done[m.id]) return false;
    const hs = parseInt(m.home.score, 10), as = parseInt(m.away.score, 10);
    if (isNaN(hs) || isNaN(as)) return false;
    const h = d.teams[String(m.home.id)] ??= { r: 1500, n: 0 };
    const a = d.teams[String(m.away.id)] ??= { r: 1500, n: 0 };
    const exp = 1 / (1 + Math.pow(10, -((h.r + (m.neutralSite ? 0 : 60)) - a.r) / 400));
    const res = hs > as ? 1 : hs === as ? 0.5 : 0;
    const gd = Math.abs(hs - as);
    const mult = gd <= 1 ? 1 : gd === 2 ? 1.3 : 1.5 + (gd - 3) * 0.1; // فوز عريض بيحرك التقييم أكتر
    const K = t => t.n < 10 ? 40 : 24; // الفرق الجديدة بتتحرك أسرع لحد ما تستقر
    const dH = +(K(h) * mult * (res - exp)).toFixed(1);
    const dA = +(K(a) * mult * ((1 - res) - (1 - exp))).toFixed(1);
    h.r = +(h.r + dH).toFixed(1); h.d = dH; // آخر تحرك — لسهم الصعود/الهبوط في الترتيب
    a.r = +(a.r + dA).toFixed(1); a.d = dA;

    // تقييم هجوم/دفاع منفصلين (حوالين 1.0) — بيغذوا حساب الأهداف المتوقعة
    h.atk ??= 1; h.def ??= 1; a.atk ??= 1; a.def ??= 1;
    const MU = 1.30; // متوسط أهداف الفريق في الماتش
    const expGH = h.atk * a.def * MU * (m.neutralSite ? 1 : 1.12);
    const expGA = a.atk * h.def * MU * (m.neutralSite ? 1 : 0.94);
    const kg = t => t.n < 10 ? 0.05 : 0.025;
    h.atk = +clampN(h.atk + kg(h) * (hs - expGH) / MU, 0.5, 2).toFixed(3);
    a.def = +clampN(a.def + kg(a) * (hs - expGH) / MU, 0.5, 2).toFixed(3);
    a.atk = +clampN(a.atk + kg(a) * (as - expGA) / MU, 0.5, 2).toFixed(3);
    h.def = +clampN(h.def + kg(h) * (as - expGA) / MU, 0.5, 2).toFixed(3);

    if (m.home.name) { h.name = m.home.name; h.logo = m.home.logo || h.logo; }
    if (m.away.name) { a.name = m.away.name; a.logo = m.away.logo || a.logo; }
    h.n++; a.n++;
    d.done[m.id] = 1; d.order.push(m.id);
    while (d.order.length > 4000) delete d.done[d.order.shift()];
    return true;
  },
  recordBatch(list) {
    let n = 0;
    for (const m of list) if (m.state === 'post' && m.finished !== false && this.record(m)) n++;
    if (n) this.save();
    return n;
  },
  teamCount() { return Object.keys(this.load().teams).length; },
  // دمج قاعدة تانية (مزامنة أو القاعدة المشتركة من الريبو): لكل فريق النسخة اللي شافت أكتر
  merge(incoming) {
    if (!incoming?.teams) return;
    const cur = this.load();
    for (const [id, t] of Object.entries(incoming.teams)) {
      if (!cur.teams[id] || (t.n || 0) > (cur.teams[id].n || 0)) cur.teams[id] = t;
    }
    for (const id of Object.keys(incoming.done || {})) {
      if (!cur.done[id]) { cur.done[id] = 1; cur.order.push(id); }
    }
    while (cur.order.length > 4000) delete cur.done[cur.order.shift()];
    this.save();
  },
};

// القاعدة المشتركة: بتتحدث ليلياً بأكشن GitHub وبيحملها أي جهاز مرة كل 12 ساعة —
// كده النظام بيتعلم حتى والموقع مقفول، وكل الأجهزة بتبدأ من قاعدة جاهزة
async function seedSharedElo() {
  const last = +(localStorage.getItem('predictor_elo_seed_ts') || 0);
  if (Date.now() - last < 12 * 3600 * 1000) return;
  try {
    const res = await fetch(`data/elo.json?ts=${Date.now()}`);
    if (!res.ok) return;
    EloDB.merge(await res.json());
    localStorage.setItem('predictor_elo_seed_ts', String(Date.now()));
  } catch { /* مش متاح */ }
}

// ---------- بيانات xG من السيرفر (Cloudflare Worker) ----------
// متاحة للدوريات الخمسة الكبار لما يكون فيه سيرفر مربوط (window.WORKER_URL)
const XG_LEAGUES = new Set(['eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1']);
const workerUrl = () => (window.WORKER_URL || '').replace(/\/+$/, '');

async function getXG(league) {
  if (!workerUrl() || !XG_LEAGUES.has(league)) return null;
  if (state.xgCache?.[league] !== undefined) return state.xgCache[league];
  state.xgCache ??= {};
  const CK = 'predictor_xg_' + league;
  const cached = store.get(CK, null);
  if (cached && Date.now() - cached.ts < 6 * 3600 * 1000) return (state.xgCache[league] = cached.teams);
  try {
    const res = await fetch(`${workerUrl()}/xg?league=${league}`);
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    store.set(CK, { ts: Date.now(), teams: data.teams });
    return (state.xgCache[league] = data.teams);
  } catch {
    return (state.xgCache[league] = cached ? cached.teams : null); // نسخة قديمة أحسن من مفيش
  }
}

// مطابقة اسم الفريق بين ESPN وUnderstat (الاسمين مش متطابقين حرفياً دايماً)
const normTeamName = s => String(s || '').toLowerCase()
  .replace(/\b(fc|cf|afc|ac|as|ssc|rc|sc|cd|ud|club|de|deportivo|calcio)\b/g, '')
  .replace(/[^a-z]/g, '');
function findXGTeam(teams, espnName) {
  if (!teams) return null;
  const target = normTeamName(espnName);
  if (!target) return null;
  let best = null;
  for (const t of teams) {
    const n = normTeamName(t.name);
    if (!n) continue;
    if (n === target) return t;
    if ((n.includes(target) || target.includes(n)) && Math.min(n.length, target.length) >= 5) best = best || t;
  }
  return best;
}

// ---------- جلب ماتشات اليوم ----------
async function loadMatches() {
  const grid = $('#matches-area');
  grid.innerHTML = '';
  $('#top-picks').innerHTML = '';
  $('#top-picks').classList.add('hidden');
  grid.appendChild(el('div', 'loading-block', '<div class="spinner"></div><p>بجيب ماتشات اليوم من كل البطولات…</p>'));

  const d0 = new Date(state.date);
  const d1 = new Date(state.date); d1.setDate(d1.getDate() + 1);
  const dm1 = new Date(state.date); dm1.setDate(dm1.getDate() - 1);
  const dateKeys = [fmtDateKey(dm1), fmtDateKey(d0), fmtDateKey(d1)];
  const targetISO = fmtDateISO(d0);

  const jobs = [];
  for (const lg of LEAGUES) {
    for (const dk of dateKeys) {
      jobs.push(
        fetchJSON(`${API}/${lg.code}/scoreboard?dates=${dk}`)
          .then(data => ({ lg, events: data.events || [] }))
          .catch(() => ({ lg, events: [] }))
      );
    }
  }
  const results = await Promise.all(jobs);

  const seen = new Set();
  const matches = [], finished = [];
  for (const { lg, events } of results) {
    for (const ev of events) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      const m = toMatch(ev, lg.code);
      if (!m) continue;
      if (m.state === 'post') finished.push(m); // أي نتيجة بتغذي تقييم Elo حتى لو مش يوم العرض
      if (fmtDateISO(new Date(ev.date)) === targetISO) matches.push(m);
    }
  }
  EloDB.recordBatch(finished);
  matches.sort((a, b) => new Date(a.date) - new Date(b.date));
  state.matches = matches;
  renderMatches();
}

// تحويل حدث ESPN لكائن ماتش موحد
// بطولات بتتلعب على ملاعب محايدة — مفيش ميزة أرض حتى لو البيانات سجلت "صاحب أرض" شكلي
const NEUTRAL_LEAGUES = new Set(['fifa.world', 'uefa.euro', 'conmebol.america', 'caf.nations']);

// الماتش خلص تماماً؟ مش كفاية حالة "post" — ساعات ESPN بيعلّمها عند نهاية
// الوقت الأصلي والماتش رايح لوقت إضافي/ضربات جزاء، أو الماتش يكون مؤجل/ملغي.
// النتيجة متتعتمدش (للتعلم أو المجموعات) غير لما تكون نهائية فعلاً.
function isFinal(statusType) {
  if (!statusType) return false;
  if (statusType.state !== 'post') return false;
  if (statusType.completed === false) return false;
  return !/POSTPONED|CANCEL|ABANDON|SUSPEND|DELAY/i.test(statusType.name || '');
}

function toMatch(ev, leagueCode) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find(c => c.homeAway === 'home');
  const away = comp.competitors?.find(c => c.homeAway === 'away');
  if (!home || !away) return null;
  return {
    id: ev.id,
    league: leagueCode,
    leagueName: LEAGUE_NAME[leagueCode] || leagueCode,
    date: ev.date,
    state: ev.status?.type?.state || 'pre',
    finished: isFinal(ev.status?.type),
    statusText: ev.status?.type?.shortDetail || '',
    neutralSite: !!comp.neutralSite || NEUTRAL_LEAGUES.has(leagueCode),
    home: { id: home.id, name: home.team?.displayName, logo: home.team?.logo, score: home.score },
    away: { id: away.id, name: away.team?.displayName, logo: away.team?.logo, score: away.score },
  };
}

// ---------- وضع الدوري: كل جولات دوري معين ----------
async function loadLeagueFixtures(code) {
  const grid = $('#matches-area');
  grid.innerHTML = '';
  $('#top-picks').innerHTML = '';
  $('#top-picks').classList.add('hidden');
  grid.appendChild(el('div', 'loading-block', `<div class="spinner"></div><p>بجيب جولات ${LEAGUE_NAME[code]}…</p>`));

  // طلبين منفصلين: الماضي والمستقبل — لأن ESPN بيتجاهل الأيام القديمة في المدى الطويل
  const from = new Date(); from.setDate(from.getDate() - 12);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const today = new Date();
  const to = new Date(); to.setDate(to.getDate() + 45);
  const ranges = [
    `${fmtDateKey(from)}-${fmtDateKey(yesterday)}`,
    `${fmtDateKey(today)}-${fmtDateKey(to)}`,
  ];
  const results = await Promise.all(ranges.map(r =>
    fetchJSON(`${API}/${code}/scoreboard?dates=${r}&limit=400`).then(d => d.events || []).catch(() => [])
  ));
  const events = results.flat();

  const seen = new Set();
  const matches = [];
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    const m = toMatch(ev, code);
    if (m) matches.push(m);
  }
  EloDB.recordBatch(matches);
  matches.sort((a, b) => new Date(a.date) - new Date(b.date));
  state.matches = matches;
  renderLeagueMatches();
}

// فهرس آخر التحليلات المحفوظة عشان الكروت تفتكرها بعد قفل الصفحة
function refreshAutologIndex() {
  state.autologByEvent = Object.fromEntries(store.get(autologKey(), []).map(r => [r.id, r]));
}

function renderLeagueMatches() {
  const grid = $('#matches-area');
  grid.innerHTML = '';
  refreshAutologIndex();
  $('#day-title').textContent = `🏆 ${LEAGUE_NAME[state.leagueView]}`;

  if (!state.matches.length) {
    grid.appendChild(el('div', 'empty-state', `<div class="empty-icon">🏆</div><h3>مفيش ماتشات متعلنة في ${LEAGUE_NAME[state.leagueView]} حالياً</h3><p>غالباً الدوري في توقف — جرب تاني قرب بداية الموسم.</p>`));
    return;
  }

  const todayISO = fmtDateISO(new Date());
  const upcoming = state.matches.filter(m => fmtDateISO(new Date(m.date)) >= todayISO);
  const past = state.matches.filter(m => fmtDateISO(new Date(m.date)) < todayISO).reverse().slice(0, 20);

  if (upcoming.length) {
    grid.appendChild(el('h2', 'mode-title', `📅 الجولات الجاية (${upcoming.length} ماتش)`));
    const byDay = {};
    for (const m of upcoming) (byDay[fmtDateISO(new Date(m.date))] ??= []).push(m);
    for (const [iso, list] of Object.entries(byDay)) {
      const section = el('section', 'league-section');
      section.appendChild(el('h2', 'league-title', `<span class="league-dot"></span>${fmtDayName(new Date(list[0].date))}`));
      const wrap = el('div', 'match-grid');
      for (const m of list) wrap.appendChild(matchCard(m));
      section.appendChild(wrap);
      grid.appendChild(section);
    }
  } else {
    grid.appendChild(el('div', 'empty-state', '<div class="empty-icon">📅</div><h3>مفيش جولات جاية متعلنة لسه</h3>'));
  }

  if (past.length) {
    grid.appendChild(el('h2', 'mode-title', '🔙 آخر النتايج'));
    const wrap = el('div', 'match-grid');
    for (const m of past) wrap.appendChild(matchCard(m));
    grid.appendChild(wrap);
  }
}

function renderLeagueBar() {
  const bar = $('#league-bar');
  bar.innerHTML = '';
  const dayChip = el('button', 'chip' + (state.mode === 'day' ? ' active' : ''), '📅 عرض حسب اليوم');
  dayChip.onclick = () => setDate(state.date);
  bar.appendChild(dayChip);
  for (const lg of LEAGUES) {
    const c = el('button', 'chip' + (state.mode === 'league' && state.leagueView === lg.code ? ' active' : ''), lg.name);
    c.onclick = () => selectLeagueView(lg.code);
    bar.appendChild(c);
  }
}

function selectLeagueView(code) {
  state.mode = 'league';
  state.leagueView = code;
  state.leagueFilter = null;
  renderLeagueBar();
  loadLeagueFixtures(code);
}

// إعادة رسم العرض الحالي (يوم أو دوري) — بتتنده بعد ما تحليل يخلص
function renderCurrent() {
  if (state.mode === 'league') renderLeagueMatches();
  else renderMatches();
}

function renderMatches() {
  const grid = $('#matches-area');
  grid.innerHTML = '';
  refreshAutologIndex();
  $('#day-title').textContent = fmtDayName(state.date);

  const filtered = state.leagueFilter ? state.matches.filter(m => m.league === state.leagueFilter) : state.matches;

  const leaguesInDay = [...new Set(state.matches.map(m => m.league))];
  const chipbar = el('div', 'league-chips');
  const allChip = el('button', 'chip' + (state.leagueFilter ? '' : ' active'), `كل البطولات (${state.matches.length})`);
  allChip.onclick = () => { state.leagueFilter = null; renderMatches(); };
  chipbar.appendChild(allChip);
  for (const code of leaguesInDay) {
    const count = state.matches.filter(m => m.league === code).length;
    const c = el('button', 'chip' + (state.leagueFilter === code ? ' active' : ''), `${LEAGUE_NAME[code]} (${count})`);
    c.onclick = () => { state.leagueFilter = code; renderMatches(); };
    chipbar.appendChild(c);
  }
  grid.appendChild(chipbar);

  // ماتشات فرقك المفضلة مثبتة فوق
  const favIds = new Set(loadFavs().map(f => String(f.id)));
  if (favIds.size) {
    const favMatches = filtered.filter(m => favIds.has(String(m.home.id)) || favIds.has(String(m.away.id)));
    if (favMatches.length) {
      const section = el('section', 'league-section fav-section');
      section.appendChild(el('h2', 'league-title', '<span class="league-dot"></span>⭐ فرقك النهارده'));
      const wrap = el('div', 'match-grid');
      for (const m of favMatches) wrap.appendChild(matchCard(m));
      section.appendChild(wrap);
      grid.appendChild(section);
    }
  }

  if (!filtered.length) {
    grid.appendChild(el('div', 'empty-state', `<div class="empty-icon">📅</div><h3>مفيش ماتشات في اليوم ده</h3><p>جرب تاريخ تاني من الفلتر فوق — أو ممكن البطولات في فترة توقف.</p>`));
    return;
  }

  const byLeague = {};
  for (const m of filtered) (byLeague[m.league] ??= []).push(m);

  for (const [code, list] of Object.entries(byLeague)) {
    const section = el('section', 'league-section');
    section.appendChild(el('h2', 'league-title', `<span class="league-dot"></span>${LEAGUE_NAME[code]}`));
    const wrap = el('div', 'match-grid');
    for (const m of list) wrap.appendChild(matchCard(m));
    section.appendChild(wrap);
    grid.appendChild(section);
  }
}

function matchCard(m) {
  const isLive = m.state === 'in';
  const isDone = m.state === 'post';
  const card = el('article', 'match-card' + (isLive ? ' live' : ''));
  const a = state.analysisCache[m.id];
  // لو مفيش تحليل في الجلسة دي، هات آخر تحليل محفوظ من السجل التلقائي
  const saved = !a ? state.autologByEvent?.[m.id]?.best : null;
  const best = a ? a.best : (saved?.label ? { pickLabel: saved.label, conf: saved.conf } : null);
  const badge = best ? `<span class="conf-badge ${confClass(best.conf)}">${best.conf}%</span>` : '';
  card.innerHTML = `
    <div class="mc-top">
      <span class="mc-time">${isLive ? '<span class="live-dot"></span> مباشر' : isDone ? 'انتهى' : fmtTime(m.date)}</span>
      ${badge}
    </div>
    <div class="mc-teams">
      <div class="mc-team">
        <img src="${m.home.logo || ''}" alt="" onerror="this.style.visibility='hidden'">
        <span>${escapeHtml(m.home.name)}</span>
      </div>
      <div class="mc-score">${(isLive || isDone) ? `${m.home.score ?? ''} - ${m.away.score ?? ''}` : 'ضد'}</div>
      <div class="mc-team">
        <img src="${m.away.logo || ''}" alt="" onerror="this.style.visibility='hidden'">
        <span>${escapeHtml(m.away.name)}</span>
      </div>
    </div>
    <div class="mc-bottom">${best ? `<span class="mc-pick">🎯 ${escapeHtml(best.pickLabel)}</span>${!a ? ' <span class="mc-hint">(تحليل سابق — اضغط للتحديث)</span>' : ''}` : '<span class="mc-hint">اضغط للتحليل الكامل</span>'}</div>
  `;
  card.onclick = () => openAnalysis(m);
  return card;
}

const confClass = c => c >= 75 ? 'conf-high' : c >= 60 ? 'conf-mid' : 'conf-low';
const confLabel = c => c >= 75 ? 'ثقة عالية' : c >= 60 ? 'ثقة متوسطة' : 'ثقة منخفضة';

// ---------- التحليل ----------
async function getAnalysis(m, { withOverlap = true } = {}) {
  if (state.analysisCache[m.id]) return state.analysisCache[m.id];

  const [summary, oppStrength, xgTable] = await Promise.all([
    fetchJSON(`${API}/${m.league}/summary?event=${m.id}`),
    getOppStrength(m.league),
    getXG(m.league),
  ]);
  const h2hGames = (summary.headToHeadGames?.[0]?.events) || [];

  const forms = summary.boxscore?.form || [];
  const formOf = teamId => (forms.find(x => String(x.team?.id) === String(teamId))?.events) || [];
  const rosterOf = teamId => ((summary.rosters || []).find(x => String(x.team?.id) === String(teamId))?.roster) || null;
  const injuriesOf = teamId => ((summary.injuries || []).find(x => String(x.team?.id) === String(teamId))?.injuries) || [];

  let overlapByGame = {};
  if (withOverlap && h2hGames.length) {
    try { overlapByGame = await computeOverlap(m, h2hGames.slice(0, 3), summary); } catch { overlapByGame = {}; }
  }

  const learned = loadLearned();
  // قوة الخصم: دمج ترتيب الدوري مع تقييم Elo (اللي متاح منهم)
  const strengthOf = id => {
    const st = oppStrength[String(id)];
    const es = EloDB.strength01(id);
    if (st != null && es != null) return 0.5 * st + 0.5 * es;
    return es ?? st ?? null;
  };
  const analysis = Engine.analyze({
    h2hGames,
    homeForm: formOf(m.home.id),
    awayForm: formOf(m.away.id),
    homeId: m.home.id,
    awayId: m.away.id,
    homeRoster: rosterOf(m.home.id),
    awayRoster: rosterOf(m.away.id),
    homeInjuries: injuriesOf(m.home.id),
    awayInjuries: injuriesOf(m.away.id),
    overlapByGame,
    neutralSite: m.neutralSite,
    kickoff: m.date,
    oppStrength,
    strengthOf,
    elo: { home: EloDB.get(m.home.id), away: EloDB.get(m.away.id) },
    adRates: { home: EloDB.get(m.home.id), away: EloDB.get(m.away.id) },
    xgRates: xgTable ? { home: findXGTeam(xgTable, m.home.name), away: findXGTeam(xgTable, m.away.name) } : null,
    marketWeight: learned.mktW || 0.45,
    pickcenter: summary.pickcenter || summary.odds || null,
    learnedWeights: learned.weights,
    calib: calibFactors(),
    homeName: m.home.name,
    awayName: m.away.name,
  });
  analysis.overlapCount = Object.keys(overlapByGame).length;
  state.analysisCache[m.id] = analysis;

  // السجل التلقائي: كل توقع لماتش لسه مبدأش بيتسجل عشان التعلم الذاتي
  if (m.state === 'pre') autolog(m, analysis);
  return analysis;
}

function autolog(m, a) {
  const log = store.get(autologKey(), []);
  const idx = log.findIndex(x => x.id === m.id);
  const rec = {
    id: m.id, league: m.league, kickoff: m.date,
    home: m.home.name, away: m.away.name,
    best: { label: a.best.pickLabel, conf: a.best.conf },
    markets: a.markets.map(mk => ({ market: mk.market, pickCode: mk.pick, label: mk.pickLabel, prob: +mk.prob.toFixed(3), mkt: mk.mkt != null ? +mk.mkt.toFixed(3) : null, conf: mk.conf })),
    leans: a.pillarLeans,
    modelPick: a.modelPick ?? null, marketPick: a.marketPick ?? null,
    status: 'pending', score: null,
  };
  if (idx >= 0) { if (log[idx].status === 'pending') log[idx] = rec; }
  else log.push(rec);
  while (log.length > 400) {
    const i = log.findIndex(x => x.status !== 'pending');
    log.splice(i >= 0 ? i : 0, 1);
  }
  store.set(autologKey(), log);
}

// مؤشر تطابق اللاعيبة
async function computeOverlap(m, recentH2h, currentSummary) {
  const currentIds = { [m.home.id]: new Set(), [m.away.id]: new Set() };
  let haveCurrent = false;

  for (const r of (currentSummary.rosters || [])) {
    const tid = String(r.team?.id);
    for (const p of (r.roster || [])) {
      const aid = p.athlete?.id;
      if (aid && currentIds[tid]) { currentIds[tid].add(String(aid)); haveCurrent = true; }
    }
  }
  if (!haveCurrent) {
    await Promise.all([m.home.id, m.away.id].map(async tid => {
      try {
        const data = await fetchJSON(`${API}/${m.league}/teams/${tid}/roster`);
        for (const grp of (data.athletes || [])) {
          const items = grp.items || (Array.isArray(grp) ? grp : []);
          for (const p of items) if (p.id) currentIds[tid].add(String(p.id));
        }
        if (currentIds[tid].size) haveCurrent = true;
      } catch { /* مش متاح */ }
    }));
  }
  if (!haveCurrent) return {};

  const out = {};
  await Promise.all(recentH2h.map(async g => {
    const code = LEAGUE_BY_ABBR[g.leagueAbbreviation] || LEAGUE_BY_ABBR[g.leagueName] || m.league;
    try {
      const oldSum = await fetchJSON(`${API}/${code}/summary?event=${g.id}`);
      let shared = 0, total = 0;
      for (const r of (oldSum.rosters || [])) {
        const tid = String(r.team?.id);
        const cur = currentIds[tid];
        if (!cur || !cur.size) continue;
        const players = (r.roster || []).filter(p => p.starter !== false);
        for (const p of players) {
          const aid = p.athlete?.id && String(p.athlete.id);
          if (!aid) continue;
          total++;
          if (cur.has(aid)) shared++;
        }
      }
      if (total >= 8) out[g.id] = shared / total;
    } catch { /* تجاهل */ }
  }));
  return out;
}

async function openAnalysis(m) {
  const modal = $('#modal');
  const body = $('#modal-body');
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="loading-block"><div class="spinner"></div><p>بحلل الماتش: مواجهات، فورمة، تشكيلات، ترتيب، وأسعار السوق…</p></div>';

  let a;
  try { a = await getAnalysis(m); }
  catch (e) {
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>معرفتش أجيب بيانات الماتش ده</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const p = a.pillars;
  const seqBadges = seq => seq.slice(0, 6).map(r => `<span class="form-b form-${r}">${r === 'W' ? 'ف' : r === 'D' ? 'ت' : 'خ'}</span>`).join('');
  const ovDetail = p.h2h.detail.filter(d => d.overlap != null);
  const ovAvg = ovDetail.length ? Math.round(ovDetail.reduce((s, d) => s + d.overlap, 0) / ovDetail.length * 100) : null;
  const restTxt = f => f.rest == null ? '' : `راحة ${f.rest} يوم${f.congestion >= 5 ? ' · جدول مضغوط ⚠️' : ''}`;
  const venueTxt = (f, label) => f.venueScore != null ? ` · ${label}: ${f.venueScore}` : '';
  const top3 = (a.topScores || []).slice(0, 3).map(s => `<b>${s.h} - ${s.a}</b> (${Math.round(s.p * 100)}%)`).join(' · ');

  body.innerHTML = `
    <div class="an-header">
      <div class="an-team"><img src="${m.home.logo || ''}" onerror="this.style.visibility='hidden'"><h3>${escapeHtml(m.home.name)}</h3><button class="fav-btn" data-side="home" title="إضافة لفرقك المفضلة">${isFav(m.home.id) ? '⭐' : '☆'}</button></div>
      <div class="an-vs">
        <div class="an-time">${m.state === 'pre' ? fmtTime(m.date) : (m.state === 'in' ? 'مباشر' : `${m.home.score} - ${m.away.score}`)}</div>
        <div class="an-league">${escapeHtml(m.leagueName)}${m.neutralSite ? ' · ملعب محايد 🏟' : ''}</div>
      </div>
      <div class="an-team"><img src="${m.away.logo || ''}" onerror="this.style.visibility='hidden'"><h3>${escapeHtml(m.away.name)}</h3><button class="fav-btn" data-side="away" title="إضافة لفرقك المفضلة">${isFav(m.away.id) ? '⭐' : '☆'}</button></div>
    </div>

    <div class="an-strength">
      <span class="st-num">${a.strength.home}</span>
      <div class="st-bar"><div class="st-fill" style="width:${(a.strength.home / (a.strength.home + a.strength.away)) * 100}%"></div></div>
      <span class="st-num">${a.strength.away}</span>
    </div>
    <p class="st-caption">مؤشر القوة الإجمالي (${Math.round(a.quality * 100)}% اكتمال بيانات)${a.eloInfo ? ` · Elo: ‏${a.eloInfo.home} ضد ${a.eloInfo.away}${a.eloInfo.weight ? '' : ' — لسه بيتبني'}` : ''}</p>

    <div class="pillars">
      <div class="pillar">
        <div class="pillar-head">🔄 المواجهات المباشرة</div>
        ${p.h2h.available ? `
          <div class="pillar-bars">
            <div class="pb-row"><span>${p.h2h.homeScore}</span><div class="pb"><div class="pb-fill" style="width:${p.h2h.homeScore}%"></div></div></div>
            <div class="pb-row"><span>${p.h2h.awayScore}</span><div class="pb"><div class="pb-fill away" style="width:${p.h2h.awayScore}%"></div></div></div>
          </div>
          <p class="pillar-note">${p.h2h.games} مواجهة (آخر 6 سنين، الأحدث وزنه أكبر)${ovAvg != null ? ` — تطابق اللاعيبة الحاليين: <b>${ovAvg}%</b>` : ''}</p>
        ` : '<p class="pillar-note">مفيش مواجهات مباشرة حديثة — وزّعنا الوزن على الفورمة والتشكيلة</p>'}
      </div>

      <div class="pillar">
        <div class="pillar-head">📈 الفورمة (موزونة بقوة الخصم وفورمة الأرض)</div>
        <div class="pillar-form-row"><span class="pf-name">${escapeHtml(m.home.name)}</span><span class="pf-badges">${seqBadges(p.form.home.seq)}</span><b>${p.form.home.score}</b></div>
        <div class="pillar-form-row"><span class="pf-name">${escapeHtml(m.away.name)}</span><span class="pf-badges">${seqBadges(p.form.away.seq)}</span><b>${p.form.away.score}</b></div>
        <p class="pillar-note">
          ${escapeHtml(m.home.name)}: ${restTxt(p.form.home)}${venueTxt(p.form.home, 'في أرضه')}<br>
          ${escapeHtml(m.away.name)}: ${restTxt(p.form.away)}${venueTxt(p.form.away, 'خارج أرضه')}<br>
          أهداف متوقعة: ${a.expGoals.home.toFixed(1)} - ${a.expGoals.away.toFixed(1)}${a.xgInfo ? ` · <b>xG</b> لكل ماتش: ${a.xgInfo.home.xg} صناعة / ${a.xgInfo.home.xga} استقبال ضد ${a.xgInfo.away.xg} / ${a.xgInfo.away.xga} 📡` : ''}${top3 ? `<br>أكثر 3 نتايج احتمالاً: ${top3}` : ''}
        </p>
      </div>

      <div class="pillar">
        <div class="pillar-head">👥 اكتمال التشكيلة</div>
        <div class="pillar-form-row"><span class="pf-name">${escapeHtml(m.home.name)}</span><span class="pf-badges">${p.squad.home.available ? `${p.squad.home.starters || 11} أساسي` : 'لم تُعلن'}${p.squad.home.injuries ? ` · ${p.squad.home.injuries} غياب` : ''}</span><b>${p.squad.home.score}</b></div>
        <div class="pillar-form-row"><span class="pf-name">${escapeHtml(m.away.name)}</span><span class="pf-badges">${p.squad.away.available ? `${p.squad.away.starters || 11} أساسي` : 'لم تُعلن'}${p.squad.away.injuries ? ` · ${p.squad.away.injuries} غياب` : ''}</span><b>${p.squad.away.score}</b></div>
        ${(!p.squad.home.available || !p.squad.away.available) ? '<p class="pillar-note">التشكيلات بتتأكد قبل الماتش بساعة تقريباً — ارجع قرّب من موعده لثقة أعلى</p>' : ''}
      </div>

      ${a.market ? `
      <div class="pillar market-pillar">
        <div class="pillar-head">💰 رأي السوق (${escapeHtml(a.market.provider)})</div>
        <div class="mkt-row">
          <span>فوز ${escapeHtml(m.home.name)}: <b>${Math.round(a.market.pH * 100)}%</b></span>
          <span>تعادل: <b>${Math.round(a.market.pD * 100)}%</b></span>
          <span>فوز ${escapeHtml(m.away.name)}: <b>${Math.round(a.market.pA * 100)}%</b></span>
        </div>
        <p class="pillar-note">${a.marketAgreement ? '✅ نظامنا متفق مع السوق — ثقة أعلى' : '⚠️ نظامنا مختلف مع السوق — خدنا بالنا ونزّلنا الثقة'}${a.market.ou ? ` · خط الأهداف ${a.market.ou.line}: أكثر ${Math.round(a.market.ou.pOver * 100)}%` : ''}</p>
      </div>` : '<div class="pillar"><div class="pillar-head">💰 رأي السوق</div><p class="pillar-note">مفيش أسعار متاحة للماتش ده — الثقة محسوبة من نموذجنا بس</p></div>'}
    </div>

    <div class="probs-bar">
      <div class="prob-seg home" style="flex:${a.probs.home}"><span>${Math.round(a.probs.home * 100)}%</span><label>فوز ${escapeHtml(m.home.name)}</label></div>
      <div class="prob-seg draw" style="flex:${a.probs.draw}"><span>${Math.round(a.probs.draw * 100)}%</span><label>تعادل</label></div>
      <div class="prob-seg away" style="flex:${a.probs.away}"><span>${Math.round(a.probs.away * 100)}%</span><label>فوز ${escapeHtml(m.away.name)}</label></div>
    </div>

    <h3 class="preds-title">🎯 التوقعات مرتبة بالثقة</h3>
    <p class="preds-hint">الاحتمال = فرصة حدوث التوقع · الشارة الملونة = ثقة النظام (الاحتمال + جودة البيانات + المعايرة الذاتية) · 💎 = نظامنا شايف قيمة أعلى من سعر السوق</p>
    <div class="preds" id="preds-list"></div>
  `;

  body.querySelectorAll('.fav-btn').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    toggleFav(b.dataset.side === 'home' ? m.home : m.away);
    b.textContent = isFav((b.dataset.side === 'home' ? m.home : m.away).id) ? '⭐' : '☆';
    if (state.currentView === 'matches') renderCurrent();
  });

  const list = $('#preds-list');
  for (const mk of a.markets) {
    const card = el('div', 'pred-card');
    card.innerHTML = `
      <div class="pred-info">
        <span class="pred-market">${mk.marketLabel}</span>
        <span class="pred-pick">${escapeHtml(mk.pickLabel)} ${mk.value ? `<span class="value-badge">💎 قيمة +${mk.value}%</span>` : ''}</span>
        <span class="pred-prob">احتمال ${Math.round(mk.prob * 100)}%</span>
      </div>
      <div class="pred-side">
        <span class="conf-badge ${confClass(mk.conf)}" title="${confLabel(mk.conf)}">${mk.conf}%</span>
        <button class="save-btn">💾 احفظ</button>
      </div>
    `;
    card.querySelector('.save-btn').onclick = ev => { ev.stopPropagation(); saveToSlip(m, mk); };
    list.appendChild(card);
  }
  renderCurrent();
}

// ---------- التحليل الجماعي (لأضمن الاختيارات وفرص القيمة) ----------
async function bulkAnalyze(btn, idleLabel) {
  const pre = state.matches.filter(m => m.state === 'pre');
  if (!pre.length) { toast('مفيش ماتشات جاية النهارده للتحليل'); return null; }

  state.bulkRunning = true;
  const total = pre.length;
  let done = 0;
  btn.disabled = true;

  const queue = [...pre];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const m = queue.shift();
      try { await getAnalysis(m, { withOverlap: false }); } catch { /* تجاهل */ }
      done++;
      btn.textContent = `⏳ بحلل ${done}/${total}…`;
    }
  });
  await Promise.all(workers);

  state.bulkRunning = false;
  btn.disabled = false;
  btn.textContent = idleLabel;
  return pre;
}

// ---------- أضمن اختيارات اليوم ----------
async function analyzeAll() {
  if (state.bulkRunning) return;
  const pre = await bulkAnalyze($('#btn-top-picks'), '⚡ أضمن اختيارات اليوم');
  if (!pre) return;

  const ranked = pre
    .map(m => ({ m, a: state.analysisCache[m.id] }))
    .filter(x => x.a)
    .sort((x, y) => y.a.best.conf - x.a.best.conf)
    .slice(0, 5);

  const top = $('#top-picks');
  top.classList.remove('hidden');
  top.innerHTML = '<div class="tp-head"><h2 class="tp-title">⚡ أضمن اختيارات اليوم</h2><button id="btn-share-picks" class="save-btn">📤 شارك كصورة</button></div>';
  top.querySelector('#btn-share-picks').onclick = shareTopPicks;
  for (const { m, a } of ranked) {
    const valueMk = a.markets.find(mk => mk.value);
    const row = el('div', 'tp-row');
    row.innerHTML = `
      <img src="${m.home.logo || ''}" onerror="this.style.visibility='hidden'">
      <img src="${m.away.logo || ''}" onerror="this.style.visibility='hidden'">
      <div class="tp-info">
        <b>${escapeHtml(m.home.name)} × ${escapeHtml(m.away.name)}</b>
        <span>${escapeHtml(a.best.pickLabel)} · ${fmtTime(m.date)}${valueMk ? ' · 💎 فيه فرصة قيمة' : ''}</span>
      </div>
      <span class="conf-badge ${confClass(a.best.conf)}">${a.best.conf}%</span>
    `;
    row.onclick = () => openAnalysis(m);
    top.appendChild(row);
  }
  renderCurrent();
}

// ---------- فرص القيمة: توقعات نظامنا شايفها أعلى من سعر السوق بفارق واضح ----------
async function showValuePicks() {
  if (state.bulkRunning) return;
  const pre = await bulkAnalyze($('#btn-value-picks'), '💎 فرص القيمة');
  if (!pre) return;

  const rows = [];
  for (const m of pre) {
    const a = state.analysisCache[m.id];
    if (!a) continue;
    for (const mk of a.markets) {
      if (mk.value) rows.push({ m, mk });
    }
  }
  rows.sort((x, y) => y.mk.value - x.mk.value);

  const top = $('#top-picks');
  top.classList.remove('hidden');
  top.innerHTML = '<h2 class="tp-title">💎 فرص القيمة النهارده</h2><p class="pillar-note" style="margin-bottom:10px">توقعات نظامنا بيقدّر احتمالها أعلى من تقدير السوق بـ 7% أو أكتر — دي المواضع اللي المحرك بيضيف فيها قيمة فوق السوق (لو المحرك صح طبعاً).</p>';
  if (!rows.length) {
    top.innerHTML += '<p class="pillar-note">مفيش فرص قيمة واضحة النهارده — النظام والسوق شايفين نفس الصورة تقريباً. ده طبيعي في معظم الأيام.</p>';
    renderCurrent();
    return;
  }
  for (const { m, mk } of rows) {
    const row = el('div', 'tp-row');
    row.innerHTML = `
      <img src="${m.home.logo || ''}" onerror="this.style.visibility='hidden'">
      <img src="${m.away.logo || ''}" onerror="this.style.visibility='hidden'">
      <div class="tp-info">
        <b>${escapeHtml(m.home.name)} × ${escapeHtml(m.away.name)}</b>
        <span>${escapeHtml(mk.pickLabel)} (${mk.marketLabel}) · احتمالنا ${Math.round(mk.prob * 100)}% ضد السوق ${mk.mkt != null ? Math.round(mk.mkt * 100) + '%' : '—'} · ${fmtTime(m.date)}</span>
      </div>
      <span class="conf-badge conf-high">💎 +${mk.value}%</span>
    `;
    row.onclick = () => openAnalysis(m);
    top.appendChild(row);
  }
  renderCurrent();
}

// ---------- المجموعات المحفوظة ----------
function saveToSlip(m, mk) {
  const slips = loadSlips();
  let choice;
  if (slips.length) {
    const names = slips.map((s, i) => `${i + 1}) ${s.name}`).join('\n');
    choice = prompt(`تحب تحفظ في أنهي مجموعة؟\n${names}\n\nاكتب رقم المجموعة، أو اكتب اسم جديد لإنشاء مجموعة:`, slips[slips.length - 1].name);
  } else {
    choice = prompt('اسم المجموعة الجديدة (مثلاً: توقعات الجمعة):', `توقعات ${fmtDayName(state.date)}`);
  }
  if (!choice) return;

  let slip;
  const idx = parseInt(choice, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= slips.length) slip = slips[idx - 1];
  else {
    slip = slips.find(s => s.name === choice.trim());
    if (!slip) { slip = { id: Date.now().toString(36), name: choice.trim(), createdAt: new Date().toISOString(), items: [] }; slips.push(slip); }
  }

  if (slip.items.some(it => it.eventId === m.id && it.market === mk.market)) { toast('التوقع ده محفوظ في المجموعة دي فعلاً'); return; }

  slip.items.push({
    eventId: m.id, league: m.league, kickoff: m.date,
    homeName: m.home.name, awayName: m.away.name,
    homeLogo: m.home.logo, awayLogo: m.away.logo,
    market: mk.market, marketLabel: mk.marketLabel,
    pickCode: mk.pick, pickLabel: mk.pickLabel,
    prob: mk.prob, conf: mk.conf,
    status: 'pending', finalScore: null,
  });
  saveSlips(slips);
  toast(`✅ اتحفظ في «${slip.name}»`);
}

function renderSlips() {
  const area = $('#slips-area');
  const slips = loadSlips();
  area.innerHTML = '';

  const all = slips.flatMap(s => s.items);
  const settled = all.filter(i => i.status === 'won' || i.status === 'lost');
  const won = settled.filter(i => i.status === 'won').length;
  const header = el('div', 'slips-header');
  header.innerHTML = `
    <div class="stat-box"><b>${all.length}</b><span>توقع محفوظ</span></div>
    <div class="stat-box"><b>${settled.length ? Math.round(won / settled.length * 100) + '%' : '—'}</b><span>دقة المحفوظات (${won}/${settled.length})</span></div>
    <button id="btn-refresh-results" class="primary-btn">🔄 حدّث النتائج</button>
  `;
  area.appendChild(header);
  header.querySelector('#btn-refresh-results').onclick = refreshResults;

  // المزامنة بين الأجهزة
  const hasWorker = !!workerUrl();
  const canUpload = hasWorker || (!!(localStorage.getItem(GH_TOKEN_KEY) || localStorage.getItem(GH_TOKEN_ENC_KEY)) && window.AUTH_ROLE === 'admin');
  const syncBox = el('div', 'slip-box');
  syncBox.innerHTML = `
    <div class="slip-head"><h3>🔁 بياناتك على أكتر من جهاز ${hasWorker ? '<span class="conf-badge conf-high">تلقائية ✓</span>' : ''}</h3></div>
    <p class="pillar-note" style="margin-bottom:10px">
      ${hasWorker
        ? 'المزامنة شغالة تلقائياً عبر السيرفر: بياناتك بتترفع مشفرة وبتتنزل على أي جهاز تدخل منه بنفس الباسورد — من غير ما تعمل حاجة. الأزرار تحت لو حبيت تزامن يدوي فوراً أو تحتفظ بنسخة ملف.'
        : `مجموعاتك وسجل التعلم متخزنين على الجهاز ده بس. عشان تنقلهم: صدّر ملف وافتحه على الجهاز التاني،
      ${canUpload ? 'أو ارفع نسخة مشفرة على الموقع تقدر تنزلها من أي جهاز تدخل منه بنفس الباسورد.' : 'أو نزّل آخر نسخة مشفرة مرفوعة لحسابك (الرفع بيتم من جهاز الأدمن).'}`}
    </p>
    <div style="display:flex; gap:8px; flex-wrap:wrap">
      <button id="btn-export-data" class="save-btn">⬇️ تصدير ملف</button>
      <button id="btn-import-data" class="save-btn">⬆️ استيراد ملف</button>
      ${canUpload ? '<button id="btn-cloud-up" class="save-btn">☁️ ارفع نسخة مشفرة</button>' : ''}
      <button id="btn-cloud-down" class="save-btn">☁️ هات آخر نسخة</button>
    </div>
  `;
  area.appendChild(syncBox);
  syncBox.querySelector('#btn-export-data').onclick = exportMyData;
  syncBox.querySelector('#btn-import-data').onclick = importMyData;
  syncBox.querySelector('#btn-cloud-down').onclick = () => cloudDownload();
  const upBtn = syncBox.querySelector('#btn-cloud-up');
  if (upBtn) upBtn.onclick = () => cloudUpload();

  if (!slips.length) {
    area.appendChild(el('div', 'empty-state', '<div class="empty-icon">📂</div><h3>مفيش مجموعات محفوظة</h3><p>افتح تحليل أي ماتش واضغط 💾 احفظ جنب التوقع اللي عاجبك.</p>'));
    return;
  }

  for (const slip of [...slips].reverse()) {
    const sWon = slip.items.filter(i => i.status === 'won').length;
    const sSettled = slip.items.filter(i => i.status !== 'pending' && i.status !== 'void').length;
    const box = el('div', 'slip-box');
    box.innerHTML = `
      <div class="slip-head">
        <h3>📂 ${escapeHtml(slip.name)}</h3>
        <div class="slip-head-side">
          <span class="slip-stat">${sSettled ? `${sWon}/${sSettled} صح` : `${slip.items.length} توقع`}</span>
          <button class="del-btn" title="حذف المجموعة">🗑</button>
        </div>
      </div>
    `;
    box.querySelector('.del-btn').onclick = () => {
      if (!confirm(`متأكد إنك عايز تحذف مجموعة «${slip.name}»؟`)) return;
      saveSlips(loadSlips().filter(s => s.id !== slip.id));
      renderSlips();
    };
    const list = el('div', 'slip-items');
    for (const it of slip.items) {
      const stIcon = it.status === 'won' ? '✅' : it.status === 'lost' ? '❌' : it.status === 'void' ? '⚪' : '⏳';
      const row = el('div', `slip-item st-${it.status}`);
      row.innerHTML = `
        <span class="si-status">${stIcon}</span>
        <img src="${it.homeLogo || ''}" onerror="this.style.visibility='hidden'">
        <img src="${it.awayLogo || ''}" onerror="this.style.visibility='hidden'">
        <div class="si-info">
          <b>${escapeHtml(it.homeName)} × ${escapeHtml(it.awayName)}</b>
          <span>${escapeHtml(it.pickLabel)} (${it.marketLabel}) · احتمال ${Math.round(it.prob * 100)}%${it.finalScore ? ` — النتيجة ${it.finalScore}` : ''}</span>
        </div>
        <span class="si-date">${new Date(it.kickoff).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })}</span>
        <span class="conf-badge ${confClass(it.conf)}">${it.conf}%</span>
        <button class="si-del" title="حذف">✕</button>
      `;
      row.querySelector('.si-del').onclick = () => {
        const fresh = loadSlips();
        const s = fresh.find(x => x.id === slip.id);
        if (s) { s.items = s.items.filter(x => !(x.eventId === it.eventId && x.market === it.market)); saveSlips(fresh); renderSlips(); }
      };
      list.appendChild(row);
    }
    box.appendChild(list);
    area.appendChild(box);
  }
}

// جلب نتايج ماتشات مجموعة من الدوريات/التواريخ
async function fetchScores(items) {
  const need = new Map();
  for (const it of items) {
    const d = new Date(it.kickoff);
    for (const shift of [0, 1, -1]) {
      const dd = new Date(d); dd.setDate(dd.getDate() + shift);
      need.set(`${it.league}|${fmtDateKey(dd)}`, { league: it.league, dk: fmtDateKey(dd) });
    }
  }
  const eventScores = {};
  const okDays = new Set(); // الأيام اللي اتجابت بنجاح — عشان نفرق بين "الماتش مخلصش" و"الطلب فشل"
  await Promise.all([...need.values()].map(async ({ league, dk }) => {
    try {
      const data = await fetchJSON(`${API}/${league}/scoreboard?dates=${dk}`, { cache: false });
      okDays.add(`${league}|${dk}`);
      for (const ev of (data.events || [])) {
        if (!isFinal(ev.status?.type)) continue; // منتهي تماماً — مش واقف على وقت إضافي ولا مؤجل
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === 'home');
        const away = comp?.competitors?.find(c => c.homeAway === 'away');
        if (home && away) eventScores[ev.id] = { h: parseInt(home.score, 10), a: parseInt(away.score, 10) };
      }
    } catch { /* تجاهل */ }
  }));
  return { eventScores, okDays };
}

// اتحسب قبل ما الماتش يخلص فعلاً؟ (اتجاب يومه بنجاح ومع ذلك مفيش نتيجة نهائية ليه)
const wronglySettled = (it, eventScores, okDays) =>
  Date.now() - new Date(it.kickoff).getTime() < 12 * 3600 * 1000 &&
  !eventScores[it.eventId ?? it.id] &&
  okDays.has(`${it.league}|${fmtDateKey(new Date(it.kickoff))}`);

async function refreshResults() {
  const btn = $('#btn-refresh-results');
  btn.disabled = true; btn.textContent = '⏳ بجيب النتائج…';
  const slips = loadSlips();
  const allItems = slips.flatMap(s => s.items);
  const pending = allItems.filter(i => i.status === 'pending' && new Date(i.kickoff).getTime() < Date.now() - 2 * 3600 * 1000);
  // التوقعات اللي اتحسبت في آخر 12 ساعة بتتراجع تاني — يمكن كانت اتعتمدت والماتش لسه شغال
  const recent = allItems.filter(i => (i.status === 'won' || i.status === 'lost') && Date.now() - new Date(i.kickoff).getTime() < 12 * 3600 * 1000);
  const { eventScores, okDays } = await fetchScores([...pending, ...recent]);

  let updated = 0, reverted = 0;
  for (const slip of slips) {
    for (const it of slip.items) {
      if (it.status === 'won' || it.status === 'lost') {
        if (wronglySettled(it, eventScores, okDays)) {
          // اتحسب والماتش لسه شغال — يرجع منتظر لحد ما يخلص بجد
          it.status = 'pending';
          it.finalScore = null;
          reverted++;
          continue;
        }
        // الماتش خلص بنتيجة نهائية مختلفة عن اللي اتسجلت بدري؟ نصححها
        const fin = eventScores[it.eventId];
        if (fin && !isNaN(fin.h) && `${fin.h}-${fin.a}` !== it.finalScore) {
          const ok2 = Engine.evaluatePick(it, fin.h, fin.a);
          it.status = ok2 === null ? 'void' : ok2 ? 'won' : 'lost';
          it.finalScore = `${fin.h}-${fin.a}`;
          updated++;
          continue;
        }
      }
      if (it.status !== 'pending') continue;
      const sc = eventScores[it.eventId];
      if (!sc || isNaN(sc.h) || isNaN(sc.a)) continue;
      const ok = Engine.evaluatePick(it, sc.h, sc.a);
      it.status = ok === null ? 'void' : ok ? 'won' : 'lost';
      it.finalScore = `${sc.h}-${sc.a}`;
      updated++;
    }
  }
  saveSlips(slips);
  renderSlips();
  toast(updated || reverted ? `✅ اتحدثت نتايج ${updated} توقع${reverted ? ` ورجعنا ${reverted} كانوا اتحسبوا قبل نهاية الماتش` : ''}` : 'مفيش نتايج جديدة لسه');
}

// ---------- صفحة الدقة والتعلم الذاتي ----------
function renderStats() {
  const area = $('#stats-area');
  const log = store.get(autologKey(), []);
  const learned = loadLearned();
  const settledLogs = log.filter(x => x.status === 'settled');

  let totalHit = 0, totalN = 0;
  for (const b of Object.values(learned.buckets)) { totalHit += b.hit; totalN += b.total; }

  area.innerHTML = '';
  const header = el('div', 'slips-header');
  header.innerHTML = `
    <div class="stat-box"><b>${log.length}</b><span>ماتش متسجل تلقائياً</span></div>
    <div class="stat-box"><b>${settledLogs.length}</b><span>ماتش اتحسبت نتيجته</span></div>
    <div class="stat-box"><b>${totalN ? Math.round(totalHit / totalN * 100) + '%' : '—'}</b><span>دقة كل التوقعات (${totalHit}/${totalN})</span></div>
    <div class="stat-box"><b>${EloDB.teamCount()}</b><span>فريق في قاعدة Elo</span></div>
    <button id="btn-learn" class="primary-btn">🧠 حدّث وتعلّم</button>
  `;
  area.appendChild(header);
  header.querySelector('#btn-learn').onclick = learnFromResults;

  // جدول المعايرة: النظام صادق مع نفسه؟
  const mids = { '90': '90%+', '80': '80-89%', '70': '70-79%', '60': '60-69%', '50': 'أقل من 60%' };
  const calBox = el('div', 'slip-box');
  calBox.innerHTML = '<div class="slip-head"><h3>🎯 جدول الصدق (المعايرة)</h3></div><p class="pillar-note" style="margin-bottom:10px">لما النظام يقول ثقة معينة — بيصيب فعلاً قد إيه؟ الفرق ده بيستخدمه النظام عشان يعاير أرقامه.</p>';
  const tbl = el('div', 'calib-table');
  for (const [b, label] of Object.entries(mids).sort((x, y) => y[0] - x[0])) {
    const s = learned.buckets[b];
    const actual = s && s.total ? Math.round(s.hit / s.total * 100) : null;
    tbl.appendChild(el('div', 'calib-row', `
      <span class="cal-label">ثقة ${label}</span>
      <div class="pb"><div class="pb-fill" style="width:${actual ?? 0}%"></div></div>
      <span class="cal-val">${actual != null ? `بيصيب ${actual}% (${s.total} توقع)` : 'لسه مفيش بيانات'}</span>
    `));
  }
  calBox.appendChild(tbl);
  area.appendChild(calBox);

  // محاكاة الربحية (ROI): لو مشينا ورا التوقعات بوحدة رهان واحدة — نكسب ولا نخسر؟
  const simulate = pickMarkets => {
    let bets = 0, profit = 0, wins = 0;
    for (const rec of settledLogs) {
      const [h, a] = (rec.score || '').split('-').map(Number);
      if (isNaN(h) || isNaN(a)) continue;
      for (const mk of pickMarkets(rec)) {
        if (mk.mkt == null || mk.mkt <= 0) continue; // محتاجين سعر السوق عشان نحسب العائد
        const ok = Engine.evaluatePick({ market: mk.market, pickCode: mk.pickCode }, h, a);
        if (ok === null) continue;
        bets++;
        if (ok) { profit += 1 / mk.mkt - 1; wins++; } else profit -= 1;
      }
    }
    return { bets, profit, wins, roi: bets ? (profit / bets) * 100 : null };
  };
  const simBest = simulate(rec => rec.markets?.length ? [rec.markets[0]] : []);
  const simValue = simulate(rec => (rec.markets || []).filter(mk => mk.mkt != null && mk.prob - mk.mkt >= 0.07));

  const roiRow = (label, s) => `
    <div class="calib-row">
      <span class="cal-label">${label}</span>
      <div class="pb"><div class="pb-fill" style="width:${s.bets ? Math.min(Math.max(50 + s.roi, 0), 100) : 0}%"></div></div>
      <span class="cal-val">${s.bets
        ? `${s.roi >= 0 ? '📈 ربح' : '📉 خسارة'} ${Math.abs(s.profit).toFixed(1)} وحدة من ${s.bets} رهان (عائد ${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(1)}% · صح ${s.wins}/${s.bets})`
        : 'لسه مفيش رهانات ليها سعر سوق محسوب'}</span>
    </div>`;
  const roiBox = el('div', 'slip-box');
  roiBox.innerHTML = `
    <div class="slip-head"><h3>💰 محاكاة الربحية (ROI)</h3></div>
    <p class="pillar-note" style="margin-bottom:10px">
      تجربة ورقية: لو راهنّا وحدة واحدة على كل توقع بأسعار السوق العادلة — النظام كان هيكسب ولا يخسر؟
      ده الاختبار الحقيقي: الدقة لوحدها متقولش حاجة، لأن التوقعات السهلة أسعارها واطية.
    </p>
    ${roiRow('🎯 أفضل توقع لكل ماتش', simBest)}
    ${roiRow('💎 فرص القيمة بس', simValue)}
    <p class="pillar-note" style="margin-top:10px">
      الحساب بالأسعار العادلة (بعد شيل هامش الشركة) — يعني الأرقام الحقيقية هتكون أقل شوية.
      عائد موجب ثابت على 50+ رهان = النظام فعلاً بيضيف قيمة فوق السوق.
      ${settledLogs.some(r => r.markets?.some(mk => mk.mkt == null)) ? '<br>ملحوظة: التوقعات المتسجلة قبل التحديث ده مفيهاش سعر سوق محفوظ فمش داخلة في الحساب.' : ''}
    </p>
  `;
  area.appendChild(roiBox);

  // الأداء بمرور الوقت — منحنيات مبنية من السجل المحسوب
  const chrono = settledLogs.filter(r => r.score).sort((x, y) => new Date(x.kickoff) - new Date(y.kickoff));
  const accPts = weeklyAccuracy(chrono);
  const roiPts = cumulativeRoi(chrono);
  const chartBox = el('div', 'slip-box');
  chartBox.innerHTML = `
    <div class="slip-head"><h3>📈 الأداء بمرور الوقت</h3></div>
    <h4 class="chart-title">دقة التوقعات أسبوع بأسبوع</h4>
    ${accPts.length >= 2 ? lineChartSVG(accPts, { color: '#f5b942', fmtY: v => Math.round(v) + '%' }) : '<p class="pillar-note">محتاج أسبوعين على الأقل من الماتشات المحسوبة (5+ توقعات في الأسبوع) — بيتبني مع الاستخدام.</p>'}
    <h4 class="chart-title">الربحية التراكمية (بالوحدات — أفضل توقع لكل ماتش بأسعار السوق)</h4>
    ${roiPts.length >= 2 ? lineChartSVG(roiPts, { color: '#56bee8', zeroLine: true, fmtY: v => (+v).toFixed(1) }) : '<p class="pillar-note">بيتبني من التوقعات اللي ليها سعر سوق محفوظ — هيظهر بعد كام ماتش محسوب.</p>'}
  `;
  area.appendChild(chartBox);

  // سجل الماتشات: اضغط على أي ماتش تشوف تشريح توقعه الكامل
  if (chrono.length) {
    const histBox = el('div', 'slip-box');
    histBox.innerHTML = '<div class="slip-head"><h3>🗂 سجل الماتشات المحسوبة</h3></div><p class="pillar-note" style="margin-bottom:10px">اضغط على أي ماتش تشوف تشريح كامل: إيه اللي كل عمود قاله، ومين صاب ومين غلط.</p>';
    const list = el('div', 'slip-items');
    for (const rec of [...chrono].reverse().slice(0, 25)) {
      const best = rec.markets?.[0];
      const [h, a] = rec.score.split('-').map(Number);
      const ok = best ? Engine.evaluatePick({ market: best.market, pickCode: best.pickCode }, h, a) : null;
      const row = el('div', 'slip-item pm-clickable');
      row.innerHTML = `
        <span class="si-status">${ok === null ? '⚪' : ok ? '✅' : '❌'}</span>
        <div class="si-info">
          <b>${escapeHtml(rec.home)} ${rec.score.split('-')[0]} - ${rec.score.split('-')[1]} ${escapeHtml(rec.away)}</b>
          <span>${best ? escapeHtml(marketLabelOf(best, rec)) : '—'} · ${fmtShortDate(rec.kickoff)}</span>
        </div>
        ${best ? `<span class="conf-badge ${confClass(best.conf)}">${best.conf}%</span>` : ''}
      `;
      row.onclick = () => openPostMortem(rec);
      list.appendChild(row);
    }
    histBox.appendChild(list);
    area.appendChild(histBox);
  }

  // أوزان الأعمدة المتعلمة
  const w = learned.weights || Engine.DEFAULT_WEIGHTS;
  const pl = learned.pillars;
  const accTxt = k => pl[k] && pl[k].total >= 5 ? ` — بيصيب ${Math.round(pl[k].hit / pl[k].total * 100)}%` : '';
  const wBox = el('div', 'slip-box');
  wBox.innerHTML = `
    <div class="slip-head"><h3>⚖️ أوزان الأعمدة ${learned.weights ? '(متعلمة من النتائج)' : '(الافتراضية)'}</h3></div>
    <div class="calib-row"><span class="cal-label">🔄 المواجهات المباشرة</span><div class="pb"><div class="pb-fill" style="width:${w.h2h * 100}%"></div></div><span class="cal-val">${Math.round(w.h2h * 100)}%${accTxt('h2h')}</span></div>
    <div class="calib-row"><span class="cal-label">📈 الفورمة</span><div class="pb"><div class="pb-fill" style="width:${w.form * 100}%"></div></div><span class="cal-val">${Math.round(w.form * 100)}%${accTxt('form')}</span></div>
    <div class="calib-row"><span class="cal-label">👥 التشكيلة</span><div class="pb"><div class="pb-fill" style="width:${w.squad * 100}%"></div></div><span class="cal-val">${Math.round(w.squad * 100)}%${accTxt('squad')}</span></div>
    <div class="calib-row"><span class="cal-label">💰 وزن رأي السوق</span><div class="pb"><div class="pb-fill" style="width:${(learned.mktW || 0.45) * 100}%"></div></div><span class="cal-val">${Math.round((learned.mktW || 0.45) * 100)}%${learned.mktW ? ' (متعلم)' : ' (افتراضي)'}</span></div>
    ${learned.mktStats?.model.total ? `<p class="pillar-note" style="margin-top:6px">في الـ ${learned.mktStats.model.total} ماتش اللي نموذجنا اختلف فيهم مع السوق: نموذجنا صاب ${Math.round(learned.mktStats.model.hit / learned.mktStats.model.total * 100)}% والسوق صاب ${Math.round(learned.mktStats.market.hit / learned.mktStats.market.total * 100)}% — والوزن بيتظبط تلقائياً على أساسها.</p>` : ''}
    <p class="pillar-note" style="margin-top:10px">النظام بيتابع أنهي عمود بيصيب أكتر في توقع نتيجة الماتش، وبيزود وزنه تدريجياً (بعد 15 ماتش محسوبة على الأقل). المعايرة كمان بتتم لكل نوع سوق لوحده أول ما العينة تكفي.</p>
  `;
  area.appendChild(wBox);

  // تدريب النموذج على أرشيف الموسم الماضي
  const trainBox = el('div', 'slip-box');
  trainBox.innerHTML = `
    <div class="slip-head"><h3>🏋️ تدريب النموذج</h3></div>
    <p class="pillar-note" style="margin-bottom:12px">
      بدل ما تستنى قاعدة التقييمات تتبني ماتش بماتش: الزرار ده بيلعب <b>الموسم الماضي كله</b>
      (كل البطولات، بالترتيب الزمني) من أرشيف النتايج — فبيبني تقييمات Elo وهجوم/دفاع كاملة فوراً،
      وبيقيس دقة النموذج على ماتشات حقيقية. بياخد دقيقة أو اتنين وبيستهلك بيانات — الأفضل على واي فاي.
      الماتشات المؤجلة والملغية مش بتدخل.
    </p>
    <button id="btn-train" class="primary-btn">🏋️ درّب النموذج على الموسم الماضي</button>
    <p id="train-result" class="pillar-note" style="margin-top:10px"></p>
    <div id="train-publish"></div>
  `;
  area.appendChild(trainBox);
  trainBox.querySelector('#btn-train').onclick = async () => {
    if (!confirm('التدريب هيجيب أرشيف موسم كامل (دقيقة-اتنين وبيانات معتبرة). نبدأ؟')) return;
    const rep = await trainOnHistory(trainBox.querySelector('#btn-train'));
    if (!rep) return;
    trainBox.querySelector('#train-result').innerHTML = rep.processed || rep.teams
      ? `✅ اتدرب على <b>${rep.processed}</b> ماتش جديد — قاعدة التقييمات بقت <b>${rep.teams}</b> فريق.` +
        (rep.evalAcc != null ? `<br>🎯 دقة النموذج في اختيار الفايز (على ${rep.evalN} ماتش محسوم): <b>${rep.evalAcc}%</b> — مقابل ${rep.homeAcc}% لو كنا بنختار صاحب الأرض دايماً.` : '')
      : 'كل ماتشات الفترة دي متسجلة عندك فعلاً — مفيش جديد.';
    const canPublish = window.AUTH_ROLE === 'admin' && !!(localStorage.getItem(GH_TOKEN_KEY) || localStorage.getItem(GH_TOKEN_ENC_KEY));
    if (canPublish && (rep.processed || rep.teams)) {
      trainBox.querySelector('#train-publish').innerHTML = '<button id="btn-publish-elo" class="save-btn" style="margin-top:8px">☁️ انشر القاعدة للموقع — كل الأجهزة تستفيد فوراً</button>';
      trainBox.querySelector('#btn-publish-elo').onclick = async ev => {
        ev.target.disabled = true; ev.target.textContent = '⏳ بنشر…';
        try {
          await ghPutFile('docs/data/elo.json', JSON.stringify(EloDB.load()), 'نشر قاعدة التقييمات بعد التدريب');
          ev.target.textContent = '✅ اتنشرت — هتوصل الأجهزة خلال دقيقة';
        } catch (err) { ev.target.disabled = false; ev.target.textContent = '❌ فشل النشر: ' + err.message; }
      };
    }
    if (state.currentView === 'stats') { /* الأرقام فوق اتغيرت */ }
  };

  if (!log.length) area.appendChild(el('div', 'empty-state', '<div class="empty-icon">🧠</div><h3>لسه مفيش سجل</h3><p>كل ماتش بتحلله بيتسجل هنا تلقائياً — وبعد ما يخلص دوس "حدّث وتعلّم" عشان النظام يقيس نفسه ويتحسن.</p>'));
}

// جوهر التعلم — بيتنده من الزرار ومن التحديث التلقائي.
// النتايج بتيجي من fetchScores اللي بيعدي كل ماتش على فحص isFinal:
// عمر ماتش لسه شغال (أو متأجل/ملغي) ما بيدخل في التعلم
async function learnCore() {
  const log = store.get(autologKey(), []);
  const pending = log.filter(x => x.status === 'pending' && new Date(x.kickoff).getTime() < Date.now() - 2 * 3600 * 1000);
  // السجلات اللي اتحسبت في آخر 12 ساعة بتتراجع — يمكن الماتش كان لسه شغال وقتها
  const recent = log.filter(x => x.status === 'settled' && Date.now() - new Date(x.kickoff).getTime() < 12 * 3600 * 1000);
  const { eventScores, okDays } = await fetchScores([...pending, ...recent]);

  const learned = loadLearned();
  let newly = 0;
  for (const rec of recent) {
    if (wronglySettled(rec, eventScores, okDays)) { rec.status = 'pending'; rec.score = null; }
    else {
      const fin = eventScores[rec.id];
      if (fin && !isNaN(fin.h)) rec.score = `${fin.h}-${fin.a}`; // تصحيح النتيجة المعروضة لو اتسجلت قبل النهاية
    }
  }
  for (const rec of log) {
    if (rec.status !== 'pending') continue;
    const sc = eventScores[rec.id];
    if (!sc || isNaN(sc.h) || isNaN(sc.a)) continue;

    // معايرة الثقة: كل سوق اتقيم حسب دلو ثقته — عام + لكل نوع سوق لوحده
    for (const mk of rec.markets) {
      const ok = Engine.evaluatePick({ market: mk.market, pickCode: mk.pickCode }, sc.h, sc.a);
      if (ok === null) continue;
      const b = Engine.bucketOf(mk.conf);
      learned.buckets[b] ??= { hit: 0, total: 0 };
      learned.buckets[b].total++;
      if (ok) learned.buckets[b].hit++;
      learned.bucketsMkt ??= {};
      const bm = (learned.bucketsMkt[mk.market] ??= {});
      bm[b] ??= { hit: 0, total: 0 };
      bm[b].total++;
      if (ok) bm[b].hit++;
    }

    // دقة الأعمدة: ميل العمود طابق نتيجة الماتش؟
    const actual = sc.h > sc.a ? 'H' : sc.h < sc.a ? 'A' : 'D';

    // نموذجنا ضد السوق: في الماتشات اللي اختلفوا فيها — مين طلع صح؟
    if (rec.modelPick && rec.marketPick && rec.modelPick !== rec.marketPick) {
      learned.mktStats ??= { model: { hit: 0, total: 0 }, market: { hit: 0, total: 0 } };
      learned.mktStats.model.total++;
      if (rec.modelPick === actual) learned.mktStats.model.hit++;
      learned.mktStats.market.total++;
      if (rec.marketPick === actual) learned.mktStats.market.hit++;
    }
    for (const k of ['h2h', 'form', 'squad']) {
      const lean = rec.leans?.[k];
      if (!lean) continue;
      learned.pillars[k] ??= { hit: 0, total: 0 };
      learned.pillars[k].total++;
      if (lean === actual) learned.pillars[k].hit++;
    }

    rec.status = 'settled';
    rec.score = `${sc.h}-${sc.a}`;
    learned.settled++;
    newly++;
  }

  // تعديل الأوزان لو عندنا عينة كافية
  const pl = learned.pillars;
  if (['h2h', 'form', 'squad'].every(k => pl[k] && pl[k].total >= 15)) {
    const acc = k => pl[k].hit / pl[k].total;
    const base = learned.weights || Engine.DEFAULT_WEIGHTS;
    const raw = { h2h: base.h2h * (0.55 + acc('h2h')), form: base.form * (0.55 + acc('form')), squad: base.squad * (0.55 + acc('squad')) };
    const s = raw.h2h + raw.form + raw.squad;
    const target = { h2h: raw.h2h / s, form: raw.form / s, squad: raw.squad / s };
    learned.weights = {
      h2h: +(0.7 * base.h2h + 0.3 * target.h2h).toFixed(3),
      form: +(0.7 * base.form + 0.3 * target.form).toFixed(3),
      squad: +(0.7 * base.squad + 0.3 * target.squad).toFixed(3),
    };
  }

  // تعديل وزن السوق: لو السوق بيكسب نموذجنا في الخلافات وزنه بيزيد تدريجياً (والعكس)
  const ms = learned.mktStats;
  if (ms && ms.model.total >= 10) {
    const gap = (ms.market.hit / ms.market.total) - (ms.model.hit / ms.model.total);
    const target = Math.max(0.30, Math.min(0.60, 0.45 + gap * 0.5));
    learned.mktW = +(0.7 * (learned.mktW || 0.45) + 0.3 * target).toFixed(3);
  }

  store.set(autologKey(), log);
  store.set(learnedKey(), learned);
  state.analysisCache = {}; // التحليلات الجاية هتستخدم الأوزان والمعايرة الجديدة
  return newly;
}

async function learnFromResults() {
  const btn = $('#btn-learn');
  btn.disabled = true; btn.textContent = '⏳ بجيب النتائج وبتعلم…';
  const newly = await learnCore();
  renderStats();
  toast(newly ? `🧠 النظام اتعلم من ${newly} ماتش جديد` : 'مفيش ماتشات جديدة خلصت لسه');
}

// التعلم التلقائي: كل ما الموقع يبقى فاتح، بيتعلم لوحده بصمت مرة كل ساعتين —
// بنفس ضمانة isFinal: الماتشات اللي خلصت تماماً بس
async function autoLearnTick() {
  if (!window.AUTH_ROLE) return;
  const key = nsKey('predictor_autolearn_ts');
  if (Date.now() - (+(localStorage.getItem(key) || 0)) < 2 * 3600 * 1000) return;
  try {
    const newly = await learnCore();
    localStorage.setItem(key, String(Date.now()));
    if (newly) {
      if (state.currentView === 'stats') renderStats();
      toast(`🧠 النظام اتعلم تلقائياً من ${newly} ماتش خلص`);
    }
  } catch { /* هيتعاد المحاولة في الدورة الجاية */ }
}

// ---------- التدريب على المواسم السابقة (Backtesting) ----------
// بيلعب الموسم الماضي كله من أرشيف ESPN بالترتيب الزمني: بيبني قاعدة
// Elo وهجوم/دفاع كاملة فوراً، وبيقيس دقة النموذج على ماتشات حقيقية.
// كل ماتش بيعدي على فحص isFinal — المؤجل والملغي مش بيدخلوا.
async function trainOnHistory(btn) {
  if (state.trainRunning) return;
  state.trainRunning = true;
  btn.disabled = true;

  const ranges = [];
  for (let i = 12; i >= 1; i--) {
    const from = new Date(); from.setDate(from.getDate() - i * 30);
    const to = new Date(); to.setDate(to.getDate() - (i - 1) * 30 - 1);
    ranges.push(`${fmtDateKey(from)}-${fmtDateKey(to)}`);
  }
  const jobs = [];
  for (const lg of LEAGUES) for (const r of ranges) jobs.push({ lg: lg.code, r });

  const events = [];
  let done = 0;
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const { lg, r } = queue.shift();
      try {
        const data = await fetchJSON(`${API}/${lg}/scoreboard?dates=${r}&limit=400`, { cache: false });
        for (const ev of (data.events || [])) {
          const m = toMatch(ev, lg);
          if (m && m.finished) events.push(m);
        }
      } catch { /* بطولة مش متاحة في الفترة دي */ }
      done++;
      btn.textContent = `⏳ بجيب الأرشيف ${Math.round(done / jobs.length * 100)}%…`;
    }
  }));

  // معالجة زمنية: الأقدم الأول عشان التقييمات تتبني صح
  const seen = new Set();
  const chrono = events
    .filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
    .sort((x, y) => new Date(x.date) - new Date(y.date));

  // تقييم النموذج وهو بيتبني: قبل ما نتعلم من الماتش، بنتوقعه الأول
  let evalN = 0, evalHit = 0, homeHit = 0;
  let processed = 0;
  const d = EloDB.load();
  for (const m of chrono) {
    const h = d.teams[String(m.home.id)], a = d.teams[String(m.away.id)];
    const hs = parseInt(m.home.score, 10), as = parseInt(m.away.score, 10);
    if (h && a && h.n >= 8 && a.n >= 8 && !isNaN(hs) && hs !== as) {
      const diff = h.r + (m.neutralSite ? 0 : 60) - a.r;
      evalN++;
      if ((diff >= 0) === (hs > as)) evalHit++;
      if (hs > as) homeHit++;
    }
    if (EloDB.record(m)) processed++;
  }
  EloDB.save();

  state.trainRunning = false;
  btn.disabled = false;
  btn.textContent = '🏋️ درّب النموذج على الموسم الماضي';
  return {
    processed, teams: EloDB.teamCount(),
    evalN, evalAcc: evalN ? Math.round(evalHit / evalN * 100) : null,
    homeAcc: evalN ? Math.round(homeHit / evalN * 100) : null,
  };
}

// ---------- مشاركة توقعات اليوم كصورة ----------
async function shareTopPicks() {
  const analyzed = state.matches.filter(m => m.state === 'pre' && state.analysisCache[m.id]);
  if (!analyzed.length) { toast('دوس «أضمن اختيارات اليوم» الأول وبعدين شارك'); return; }
  const ranked = analyzed
    .map(m => ({ m, a: state.analysisCache[m.id] }))
    .sort((x, y) => y.a.best.conf - x.a.best.conf)
    .slice(0, 6);

  const W = 1080, rowH = 150, top = 300, H = top + ranked.length * rowH + 130;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.direction = 'rtl';

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#101a30'); bg.addColorStop(1, '#0b1120');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#f5b942';
  ctx.font = '900 64px Tahoma, Arial';
  ctx.textAlign = 'center';
  ctx.fillText('⚽ المُتنبئ', W / 2, 110);
  ctx.fillStyle = '#8fa3c8';
  ctx.font = '600 36px Tahoma, Arial';
  ctx.fillText(`أضمن اختيارات ${fmtDayName(state.date)}`, W / 2, 175);
  ctx.strokeStyle = 'rgba(245,185,66,.4)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(80, 215); ctx.lineTo(W - 80, 215); ctx.stroke();

  ranked.forEach(({ m, a }, i) => {
    const y = top + i * rowH;
    ctx.fillStyle = 'rgba(255,255,255,.045)';
    ctx.beginPath(); ctx.roundRect(60, y - 55, W - 120, rowH - 20, 18); ctx.fill();

    ctx.textAlign = 'right';
    ctx.fillStyle = '#eef2fa';
    ctx.font = '800 38px Tahoma, Arial';
    ctx.fillText(`${m.home.name} × ${m.away.name}`, W - 100, y);
    ctx.fillStyle = '#8fa3c8';
    ctx.font = '600 32px Tahoma, Arial';
    ctx.fillText(`🎯 ${a.best.pickLabel} · ${fmtTime(m.date)}`, W - 100, y + 52);

    const conf = a.best.conf;
    ctx.fillStyle = conf >= 75 ? '#2e9e5b' : conf >= 60 ? '#c8892a' : '#a84450';
    ctx.beginPath(); ctx.roundRect(85, y - 24, 130, 62, 31); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = '900 34px Tahoma, Arial';
    ctx.fillText(`${conf}%`, 150, y + 20);
  });

  ctx.textAlign = 'center';
  ctx.fillStyle = '#5b6c8f';
  ctx.font = '600 26px Tahoma, Arial';
  ctx.fillText('توقعات آلية بمحرك الثقة — للاستئناس، مش نصيحة مالية', W / 2, H - 55);

  cv.toBlob(async blob => {
    const file = new File([blob], 'predictions.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'توقعات المُتنبئ' }); return; } catch { /* اتلغت */ }
    }
    const aEl = document.createElement('a');
    aEl.href = URL.createObjectURL(blob);
    aEl.download = 'predictions.png';
    aEl.click();
    URL.revokeObjectURL(aEl.href);
    toast('📤 اتحملت صورة التوقعات — شاركها براحتك');
  }, 'image/png');
}

// ---------- رسم بياني خطي خفيف (SVG من غير مكتبات) ----------
function lineChartSVG(points, { color = '#f5b942', fmtY = v => Math.round(v), zeroLine = false } = {}) {
  if (points.length < 2) return '';
  const W = 640, H = 200, P = { t: 18, r: 56, b: 26, l: 10 };
  const ys = points.map(p => p.y);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const X = i => P.l + (W - P.l - P.r) * (i / (points.length - 1));
  const Y = v => P.t + (H - P.t - P.b) * (1 - (v - lo) / (hi - lo));
  const grid = [0, 0.5, 1].map(f => {
    const v = lo + (hi - lo) * f;
    return `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="ch-grid"/>` +
           `<text x="${W - P.r + 8}" y="${(Y(v) + 4).toFixed(1)}" class="ch-tick">${fmtY(v)}</text>`;
  }).join('');
  const zero = zeroLine && lo < 0 && hi > 0 ? `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" class="ch-zero"/>` : '';
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const dots = points.map((p, i) =>
    `<g class="ch-pt"><circle cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="12" fill="transparent"/>` +
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3.5" fill="${color}"/><title>${escapeHtml(p.tip)}</title></g>`
  ).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${grid}${zero}` +
    `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}` +
    `<text x="${X(points.length - 1).toFixed(1)}" y="${(Y(last.y) - 10).toFixed(1)}" class="ch-last" fill="${color}" text-anchor="end">${fmtY(last.y)}</text>` +
    `<text x="${X(0).toFixed(1)}" y="${H - 6}" class="ch-tick" text-anchor="start">${escapeHtml(points[0].x)}</text>` +
    `<text x="${X(points.length - 1).toFixed(1)}" y="${H - 6}" class="ch-tick" text-anchor="end">${escapeHtml(last.x)}</text></svg>`;
}

const fmtShortDate = d => new Date(d).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });

// دقة كل أسبوع (كل الأسواق المتقيمة فيه)
function weeklyAccuracy(settled) {
  const weeks = {};
  for (const rec of settled) {
    const d = new Date(rec.kickoff);
    const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = fmtDateISO(monday);
    const [h, a] = rec.score.split('-').map(Number);
    for (const mk of (rec.markets || [])) {
      const ok = Engine.evaluatePick({ market: mk.market, pickCode: mk.pickCode }, h, a);
      if (ok === null) continue;
      const w = (weeks[key] ??= { hit: 0, total: 0 });
      w.total++;
      if (ok) w.hit++;
    }
  }
  return Object.entries(weeks)
    .filter(([, w]) => w.total >= 5)
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, w]) => ({
      x: fmtShortDate(k),
      y: Math.round(w.hit / w.total * 100),
      tip: `أسبوع ${fmtShortDate(k)}: ${w.hit} صح من ${w.total} (${Math.round(w.hit / w.total * 100)}%)`,
    }));
}

// الربحية التراكمية: وحدة على أفضل توقع لكل ماتش بأسعار السوق العادلة
function cumulativeRoi(settled) {
  const pts = [];
  let cum = 0;
  for (const rec of settled) {
    const mk = rec.markets?.[0];
    if (!mk || mk.mkt == null || mk.mkt <= 0) continue;
    const [h, a] = rec.score.split('-').map(Number);
    const ok = Engine.evaluatePick({ market: mk.market, pickCode: mk.pickCode }, h, a);
    if (ok === null) continue;
    cum += ok ? 1 / mk.mkt - 1 : -1;
    pts.push({
      x: fmtShortDate(rec.kickoff),
      y: +cum.toFixed(2),
      tip: `${rec.home} × ${rec.away}: ${ok ? `✅ +${(1 / mk.mkt - 1).toFixed(2)}` : '❌ −1.00'} → الرصيد ${cum.toFixed(2)}`,
    });
  }
  return pts;
}

// ---------- تشريح التوقع بعد الماتش ----------
const pickText = (code, rec) => code === 'H' ? `فوز ${rec.home}` : code === 'A' ? `فوز ${rec.away}` : 'تعادل';
function marketLabelOf(mk, rec) {
  if (mk.label) return mk.label;
  switch (mk.market) {
    case '1X2': return pickText(mk.pickCode, rec);
    case 'DC': return mk.pickCode === '1X' ? `فوز أو تعادل ${rec.home}` : mk.pickCode === 'X2' ? `فوز أو تعادل ${rec.away}` : 'لا تعادل';
    case 'OU15': case 'OU25': case 'OU35': return `${mk.pickCode === 'O' ? 'أكثر' : 'أقل'} من ${mk.market.slice(2, 3)}.5 هدف`;
    case 'BTTS': return mk.pickCode === 'Y' ? 'الفريقين يسجلوا' : 'مش هيسجلوا مع بعض';
    case 'CS': return `النتيجة ${mk.pickCode}`;
  }
  return mk.market;
}
const MARKET_NAMES = { '1X2': 'نتيجة الماتش', DC: 'فرصة مزدوجة', OU15: 'خط 1.5', OU25: 'خط 2.5', OU35: 'خط 3.5', BTTS: 'تسجيل الفريقين', CS: 'النتيجة بالظبط' };

function openPostMortem(rec) {
  const [h, a] = rec.score.split('-').map(Number);
  const actual = h > a ? 'H' : h < a ? 'A' : 'D';
  const okIcon = ok => ok === null ? '⚪' : ok ? '✅' : '❌';
  const leanNames = { h2h: '🔄 المواجهات المباشرة', form: '📈 الفورمة', squad: '👥 التشكيلة' };

  const pillarRows = Object.entries(leanNames).map(([k, name]) => {
    const lean = rec.leans?.[k];
    if (!lean) return `<div class="pm-row"><span>${name}</span><span class="pm-said">مقالش رأي</span><span>⚪</span></div>`;
    return `<div class="pm-row"><span>${name}</span><span class="pm-said">قال: ${pickText(lean, rec)}</span><span>${okIcon(lean === actual)}</span></div>`;
  }).join('');

  const vsMarket = rec.modelPick && rec.marketPick ? `
    <div class="pm-row"><span>🧠 نموذجنا (قبل دمج السوق)</span><span class="pm-said">قال: ${pickText(rec.modelPick, rec)}</span><span>${okIcon(rec.modelPick === actual)}</span></div>
    <div class="pm-row"><span>💰 السوق</span><span class="pm-said">قال: ${pickText(rec.marketPick, rec)}</span><span>${okIcon(rec.marketPick === actual)}</span></div>
  ` : '<p class="pillar-note">مفيش مقارنة نموذج/سوق متسجلة للماتش ده (اتسجل قبل الميزة دي)</p>';

  const marketRows = (rec.markets || []).map(mk => {
    const ok = Engine.evaluatePick({ market: mk.market, pickCode: mk.pickCode }, h, a);
    return `<div class="pm-row"><span>${MARKET_NAMES[mk.market] || mk.market}</span><span class="pm-said">${escapeHtml(marketLabelOf(mk, rec))} <small>(ثقة ${mk.conf}%)</small></span><span>${okIcon(ok)}</span></div>`;
  }).join('');

  $('#modal').classList.remove('hidden');
  $('#modal-body').innerHTML = `
    <div class="an-header pm-header">
      <h3>${escapeHtml(rec.home)} <b class="pm-score">${rec.score.split('-')[0]} - ${rec.score.split('-')[1]}</b> ${escapeHtml(rec.away)}</h3>
      <p class="pillar-note">${fmtShortDate(rec.kickoff)} · ${escapeHtml(LEAGUE_NAME[rec.league] || rec.league)} — النتيجة الفعلية: <b>${pickText(actual, rec)}</b></p>
    </div>
    <h4 class="pm-title">إيه اللي كل عمود قاله؟</h4>
    <div class="pm-rows">${pillarRows}</div>
    <h4 class="pm-title">نموذجنا ضد السوق</h4>
    <div class="pm-rows">${vsMarket}</div>
    <h4 class="pm-title">كل التوقعات المتسجلة</h4>
    <div class="pm-rows">${marketRows}</div>
  `;
}

// ---------- ترتيب Elo ----------
function renderEloBoard() {
  const area = $('#elo-area');
  const teams = Object.entries(EloDB.load().teams)
    .map(([id, t]) => ({ id, ...t }))
    .filter(t => t.n >= 5 && t.name)
    .sort((x, y) => y.r - x.r)
    .slice(0, 100);

  area.innerHTML = '';
  const box = el('div', 'slip-box');
  box.innerHTML = `
    <div class="slip-head"><h3>🏆 ترتيب القوة (Elo) — ${teams.length} فريق</h3></div>
    <p class="pillar-note" style="margin-bottom:12px">
      مقياس قوة موحد لكل الفرق في كل البطولات، بيتبني تلقائياً من كل نتيجة الموقع بيشوفها —
      فوز على فريق قوي بيرفعك أكتر، وخسارة من ضعيف بتنزلك أكتر. الفريق بيدخل الترتيب بعد 5 ماتشات متسجلة.
      السهم بيوضح آخر تحرك.
    </p>
    <div id="elo-rows"></div>
  `;
  area.appendChild(box);

  const rows = box.querySelector('#elo-rows');
  if (!teams.length) {
    rows.innerHTML = '<div class="empty-state"><div class="empty-icon">🏗</div><h3>الترتيب لسه بيتبني</h3><p>كل ما تتصفح ماتشات وتحدث نتايج، الفرق بتتسجل تلقائياً — ارجع بعد كام يوم استخدام.</p></div>';
    return;
  }
  teams.forEach((t, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    const arrow = t.d > 0.5 ? '<span class="elo-up">▲</span>' : t.d < -0.5 ? '<span class="elo-down">▼</span>' : '<span class="elo-flat">—</span>';
    const row = el('div', 'slip-item elo-row');
    row.innerHTML = `
      <span class="elo-rank">${medal}</span>
      <img src="${t.logo || ''}" onerror="this.style.visibility='hidden'">
      <div class="si-info"><b>${escapeHtml(t.name)}</b><span>${t.n} ماتش متسجل</span></div>
      ${arrow}
      <b class="elo-rating">${Math.round(t.r)}</b>
    `;
    rows.appendChild(row);
  });
}

// ---------- مولّد المجموعة الذكي ----------
function openSlipGenerator() {
  if (state.bulkRunning) return;
  $('#modal').classList.remove('hidden');
  $('#modal-body').innerHTML = `
    <h3 class="preds-title">🎫 اعمل مجموعة النهارده</h3>
    <p class="pillar-note" style="margin-bottom:14px">بحلل كل ماتشات اليوم وأجمعلك أحسن التوقعات في مجموعة جاهزة حسب شروطك:</p>
    <form id="gen-form" class="admin-form gen-form">
      <label class="gen-label">أقل ثقة مقبولة
        <select id="gen-conf" class="admin-select">
          <option value="65">65%</option>
          <option value="70" selected>70%</option>
          <option value="75">75%</option>
          <option value="80">80%</option>
        </select>
      </label>
      <label class="gen-label">عدد التوقعات
        <select id="gen-count" class="admin-select">
          <option value="3">3</option>
          <option value="5" selected>5</option>
          <option value="7">7</option>
          <option value="10">10</option>
        </select>
      </label>
      <label class="gen-check"><input type="checkbox" id="gen-value" checked> الأولوية لفرص القيمة 💎</label>
      <label class="gen-check"><input type="checkbox" id="gen-cs"> اسمح بتوقعات «النتيجة بالظبط» (مخاطرة عالية)</label>
      <button type="submit" class="primary-btn">⚡ حلل واعمل المجموعة</button>
    </form>
    <div id="gen-result"></div>
  `;
  $('#gen-form').onsubmit = async e => {
    e.preventDefault();
    const minConf = +$('#gen-conf').value;
    const count = +$('#gen-count').value;
    const preferValue = $('#gen-value').checked;
    const allowCS = $('#gen-cs').checked;
    const btn = e.target.querySelector('button');
    const pre = await bulkAnalyze(btn, '⚡ حلل واعمل المجموعة');
    if (!pre) return;

    // أحسن توقع مؤهل من كل ماتش — بحد أقصى توقع واحد للماتش عشان المجموعة متبقاش مترابطة
    const candidates = [];
    for (const m of pre) {
      const a = state.analysisCache[m.id];
      if (!a) continue;
      const eligible = a.markets.filter(mk => mk.conf >= minConf && (allowCS || mk.market !== 'CS'));
      if (!eligible.length) continue;
      const best = [...eligible].sort((x, y) => (preferValue ? (y.value || 0) - (x.value || 0) : 0) || y.conf - x.conf)[0];
      candidates.push({ m, mk: best });
    }
    candidates.sort((x, y) => (preferValue ? (y.mk.value || 0) - (x.mk.value || 0) : 0) || y.mk.conf - x.mk.conf);
    const chosen = candidates.slice(0, count);

    const result = $('#gen-result');
    if (!chosen.length) {
      result.innerHTML = `<p class="pillar-note" style="margin-top:12px">⚠️ مفيش توقعات النهارده بثقة ${minConf}%+ — نزّل الحد شوية أو جرب يوم تاني.</p>`;
      return;
    }

    const slips = loadSlips();
    const slip = { id: Date.now().toString(36), name: `🎫 مجموعة ${fmtDayName(state.date)}`, createdAt: new Date().toISOString(), items: [] };
    for (const { m, mk } of chosen) {
      slip.items.push({
        eventId: m.id, league: m.league, kickoff: m.date,
        homeName: m.home.name, awayName: m.away.name,
        homeLogo: m.home.logo, awayLogo: m.away.logo,
        market: mk.market, marketLabel: mk.marketLabel,
        pickCode: mk.pick, pickLabel: mk.pickLabel,
        prob: mk.prob, conf: mk.conf,
        status: 'pending', finalScore: null,
      });
    }
    slips.push(slip);
    saveSlips(slips);

    result.innerHTML = `
      <h4 class="pm-title">✅ اتعملت مجموعة «${escapeHtml(slip.name)}» — ${chosen.length} توقع:</h4>
      <div class="pm-rows">
        ${chosen.map(({ m, mk }) => `<div class="pm-row"><span>${escapeHtml(m.home.name)} × ${escapeHtml(m.away.name)}</span><span class="pm-said">${escapeHtml(mk.pickLabel)}${mk.value ? ' 💎' : ''}</span><span class="conf-badge ${confClass(mk.conf)}">${mk.conf}%</span></div>`).join('')}
      </div>
      <p class="pillar-note" style="margin-top:10px">هتلاقيها في تبويب «📂 مجموعاتي» — وبعد الماتشات دوس «حدّث النتائج» هناك.</p>
    `;
    renderCurrent();
  };
}

// ---------- المزامنة بين الأجهزة ----------
// البيانات بتتشفر AES-GCM بمفتاح مشتق من كلمة السر نفسها (PBKDF2) —
// فبتتفك على أي جهاز داخل بنفس الباسورد، ومحدش تاني يقدر يقراها حتى لو الملف عام
const SYNC_DIR = 'docs/sync';
const syncId = () => (window.DATA_NS || (window.AUTH_HASH || '').slice(0, 10));

async function dataCryptoKey(usages) {
  if (!window.DATA_KEY) return null;
  const raw = Uint8Array.from(atob(window.DATA_KEY), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);
}

function collectMyData() {
  return {
    v: 1,
    exportedAt: new Date().toISOString(),
    slips: loadSlips(),
    autolog: store.get(autologKey(), []),
    learned: loadLearned(),
    elo: store.get(ELO_KEY, null),
    favs: loadFavs(),
  };
}

// دمج بيانات جهاز تاني مع بيانات الجهاز ده — من غير ما نضيّع حاجة من الاتنين
function mergeMyData(incoming) {
  if (!incoming || incoming.v !== 1) throw new Error('صيغة الملف مش مفهومة');

  const slips = loadSlips();
  for (const inSlip of (incoming.slips || [])) {
    const local = slips.find(s => s.id === inSlip.id);
    if (!local) { slips.push(inSlip); continue; }
    for (const it of (inSlip.items || [])) {
      const cur = local.items.find(x => x.eventId === it.eventId && x.market === it.market);
      if (!cur) local.items.push(it);
      else if (cur.status === 'pending' && it.status !== 'pending') Object.assign(cur, it);
    }
  }
  saveSlips(slips);

  const log = store.get(autologKey(), []);
  const byId = new Map(log.map(r => [r.id, r]));
  for (const rec of (incoming.autolog || [])) {
    const cur = byId.get(rec.id);
    if (!cur) { log.push(rec); byId.set(rec.id, rec); }
    else if (cur.status === 'pending' && rec.status === 'settled') Object.assign(cur, rec);
  }
  store.set(autologKey(), log);

  const learned = loadLearned();
  if ((incoming.learned?.settled || 0) > (learned.settled || 0)) store.set(learnedKey(), incoming.learned);

  // الفرق المفضلة: اتحاد الاتنين
  if (Array.isArray(incoming.favs)) {
    const favs = loadFavs();
    for (const f of incoming.favs) if (!favs.some(x => String(x.id) === String(f.id))) favs.push(f);
    store.set(favsKey(), favs);
  }

  // قاعدة Elo: لكل فريق ناخد النسخة اللي شافت ماتشات أكتر
  if (incoming.elo?.teams) EloDB.merge(incoming.elo);

  state.analysisCache = {};
}

function exportMyData() {
  const blob = new Blob([JSON.stringify(collectMyData(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `predictor-backup-${fmtDateISO(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('⬇️ اتحملت نسخة من بياناتك — خزنها أو افتحها على جهاز تاني');
}

function importMyData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        mergeMyData(JSON.parse(reader.result));
        toast('✅ البيانات اتدمجت مع اللي عندك');
        renderSlips();
      } catch (e) { toast('❌ الملف ده مش نسخة صالحة: ' + e.message); }
    };
    reader.readAsText(file);
  };
  input.click();
}

async function buildEncryptedPayload() {
  const key = await dataCryptoKey(['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(collectMyData()))));
  const buf = new Uint8Array(12 + ct.length); buf.set(iv); buf.set(ct, 12);
  let b64 = ''; for (let i = 0; i < buf.length; i += 0x8000) b64 += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return JSON.stringify({ enc: btoa(b64), updatedAt: new Date().toISOString() });
}

async function decryptAndMerge(enc) {
  const buf = Uint8Array.from(atob(enc), c => c.charCodeAt(0));
  const key = await dataCryptoKey(['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
  mergeMyData(JSON.parse(new TextDecoder().decode(pt)));
}

async function cloudUpload({ silent = false } = {}) {
  if (!window.DATA_KEY) { if (!silent) toast('سجل خروج وادخل تاني الأول عشان مفتاح التشفير يتجهز'); return false; }
  const payload = await buildEncryptedPayload();
  try {
    if (workerUrl()) {
      // السيرفر: فوري ومتاح لكل المستخدمين من غير مفتاح GitHub
      const res = await fetch(`${workerUrl()}/sync/${syncId()}`, { method: 'PUT', body: payload, headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (!silent) toast('☁️ اترفعت فوراً — أي جهاز بنفس الباسورد ياخدها على طول');
    } else {
      await ghPutFile(`${SYNC_DIR}/${syncId()}.json`, payload, 'مزامنة بيانات مستخدم');
      if (!silent) toast('☁️ اترفعت — أي جهاز هيدخل بنفس الباسورد يقدر ينزلها بعد دقيقة');
    }
    return true;
  } catch (e) { if (!silent) toast('❌ فشل الرفع: ' + e.message); return false; }
}

async function cloudDownload({ silent = false } = {}) {
  if (!window.DATA_KEY) { if (!silent) toast('سجل خروج وادخل تاني الأول عشان مفتاح التشفير يتجهز'); return false; }
  try {
    const res = workerUrl()
      ? await fetch(`${workerUrl()}/sync/${syncId()}`)
      : await fetch(`sync/${syncId()}.json?ts=${Date.now()}`);
    if (res.status === 404) { if (!silent) toast('مفيش نسخة مرفوعة لحسابك لسه — ارفع من الجهاز الأساسي الأول'); return false; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { enc } = await res.json();
    await decryptAndMerge(enc);
    if (!silent) { toast('✅ آخر نسخة اتدمجت مع بيانات الجهاز ده'); renderSlips(); }
    return true;
  } catch (e) { if (!silent) toast('❌ فشل التنزيل: ' + e.message); return false; }
}

// المزامنة التلقائية (مع السيرفر بس): تنزيل ودمج عند الفتح، ورفع صامت كل شوية
let autoSyncBusy = false;
async function autoSyncTick(first = false) {
  if (!workerUrl() || !window.DATA_KEY || autoSyncBusy) return;
  autoSyncBusy = true;
  try {
    if (first) await cloudDownload({ silent: true }); // هات اللي اتعمل على الأجهزة التانية
    await cloudUpload({ silent: true });
  } catch { /* المحاولة الجاية */ }
  autoSyncBusy = false;
}

// ---------- صفحة الإدارة (للأدمن بس) ----------
const GH_OWNER = 'abanoub-maged145';
const GH_REPO = 'predictions';
const GH_CONFIG_PATH = 'docs/config.js';
const GH_TOKEN_KEY = 'predictor_gh_token';          // النسخة القديمة (غير مشفرة) — بتترحّل تلقائياً
const GH_TOKEN_ENC_KEY = 'predictor_gh_token_enc';  // المفتاح مشفر بمفتاح الأدمن
const PBKDF2_ITER = 310000;

const sha256Text = async text => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};

// بصمة PBKDF2 — بطيئة عمداً عشان تخمين الباسوردات من البصمات المنشورة يبقى شبه مستحيل
async function pbkdf2Text(password, saltB64, iter = PBKDF2_ITER) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, keyMat, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const newSaltB64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

// مفتاح GitHub: بنقرأه مشفر لو متوفر مفتاح الأدمن، أو النسخة القديمة غير المشفرة
async function getGhToken() {
  const enc = localStorage.getItem(GH_TOKEN_ENC_KEY);
  if (enc) {
    const plain = await decryptPass(enc);
    if (plain) return plain;
  }
  return localStorage.getItem(GH_TOKEN_KEY);
}

// رفع/تحديث ملف في الريبو عبر GitHub API (بيستخدمه نشر الإعدادات والمزامنة)
async function ghPutFile(path, content, message) {
  const token = await getGhToken();
  if (!token) throw new Error('مفيش مفتاح GitHub محفوظ — اربط GitHub من صفحة الإدارة الأول');
  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' };

  let sha;
  const cur = await fetch(api, { headers });
  if (cur.ok) sha = (await cur.json()).sha;
  else if (cur.status !== 404) throw new Error('HTTP ' + cur.status);

  const b64 = btoa(unescape(encodeURIComponent(content)));
  const res = await fetch(api, {
    method: 'PUT', headers,
    body: JSON.stringify({ message, content: b64, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

// أدوات باسوردات المستخدمين
const fmtD = iso => iso ? new Date(iso).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
const passExpired = p => !!p.expires && Date.parse(p.expires) <= Date.now();
let adminEditIndex = null; // مؤشر الباسورد اللي بيتعدل حالياً

// تشفير/فك تشفير الباسورد بمفتاح مشتق من كلمة سر الأدمن —
// بيتخزن مشفر في الريبو العام ومحدش يفكه غير اللي معاه كلمة سر الأدمن
async function adminCryptoKey(usages) {
  const b64 = sessionStorage.getItem('predictor_admin_key');
  if (!b64) return null;
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);
}
async function encryptPass(plain) {
  const key = await adminCryptoKey(['encrypt']);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  const buf = new Uint8Array(12 + ct.length); buf.set(iv); buf.set(ct, 12);
  return btoa(String.fromCharCode(...buf));
}
async function decryptPass(enc) {
  try {
    const key = await adminCryptoKey(['decrypt']);
    if (!key || !enc) return null;
    const buf = Uint8Array.from(atob(enc), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

function renderAdmin() {
  const area = $('#admin-area');
  const hasToken = !!(localStorage.getItem(GH_TOKEN_KEY) || localStorage.getItem(GH_TOKEN_ENC_KEY));

  // ترحيل المفتاح القديم غير المشفر → نسخة مشفرة بمفتاح الأدمن
  const legacyToken = localStorage.getItem(GH_TOKEN_KEY);
  if (legacyToken) {
    encryptPass(legacyToken).then(enc => {
      if (enc) { localStorage.setItem(GH_TOKEN_ENC_KEY, enc); localStorage.removeItem(GH_TOKEN_KEY); }
    });
  }
  const passes = window.USER_PASSES || [];
  const needsUpgrade = !window.ADMIN_SALT || passes.some(p => !p.salt);
  const expiredCount = passes.filter(passExpired).length;
  const editing = adminEditIndex != null ? passes[adminEditIndex] : null;

  const rows = passes.map((p, i) => {
    const expired = passExpired(p);
    return `
      <div class="slip-item ${expired ? 'st-lost' : ''}">
        <span class="si-status">${expired ? '⛔' : '🔑'}</span>
        <div class="si-info">
          <b>${escapeHtml(p.label || 'مستخدم')}</b>
          <span>بداية: ${fmtD(p.created) || '—'} · ${p.expires ? `تنتهي: ${fmtD(p.expires)}` : 'من غير انتهاء'}${expired ? ' · <b style="color:var(--red)">منتهية — مش بتفتح</b>' : ''}</span>
        </div>
        <button class="save-btn" data-edit="${i}">✏️ تعديل</button>
        <button class="si-del" data-del="${i}" title="حذف">✕</button>
      </div>`;
  }).join('') || '<p class="pillar-note">مفيش باسوردات مستخدمين — ضيف واحد من الفورم تحت.</p>';

  area.innerHTML = `
    <div class="slip-box">
      <div class="slip-head">
        <h3>🔑 باسوردات المستخدمين (${passes.length - expiredCount} سارية${expiredCount ? ` · ${expiredCount} منتهية` : ''})</h3>
        ${expiredCount ? '<button id="admin-clean-expired" class="save-btn">🧹 امسح المنتهية</button>' : ''}
      </div>
      <p class="pillar-note" style="margin-bottom:10px">
        كل باسورد ليه اسم صاحبه ومدة صلاحية — لما المدة تخلص بيتقفل <b>تلقائياً</b> وصاحبه مش بيعرف يدخل.
        حذف أو تعديل أي باسورد بيسجل خروج صاحبه فوراً. كلمة سر الأدمن بتاعتك منفصلة ومش بتتأثر.
      </p>
      <div class="slip-items">${rows}</div>
      <hr style="border-color:var(--border); margin:16px 0; border-style:solid; border-width:1px 0 0">
      <h4 style="margin-bottom:10px">${editing ? `✏️ تعديل باسورد «${escapeHtml(editing.label || 'مستخدم')}»` : '➕ إضافة باسورد جديد'}</h4>
      ${editing ? '<p id="admin-current-pass" class="pillar-note" style="margin-bottom:10px">⏳ بجيب الباسورد الحالي…</p>' : ''}
      <form id="admin-pass-form" class="admin-form">
        <input type="text" id="admin-pass-label" placeholder="اسم صاحب الباسورد (مثلاً: أحمد)" value="${editing ? escapeHtml(editing.label || '') : ''}">
        <input type="password" id="admin-pass-value" placeholder="${editing ? 'كلمة السر — سيبها فاضية لو مش عايز تغيّرها' : 'كلمة السر'}" autocomplete="new-password">
        <select id="admin-pass-days" class="admin-select">
          <option value="7">صلاحية أسبوع</option>
          <option value="30" selected>صلاحية شهر</option>
          <option value="90">صلاحية 3 شهور</option>
          <option value="365">صلاحية سنة</option>
          <option value="">من غير انتهاء</option>
        </select>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <button type="submit" class="primary-btn" ${hasToken ? '' : 'disabled title="اربط GitHub الأول من تحت"'}>${editing ? '💾 احفظ وانشر' : '🚀 أضف وانشر'}</button>
          ${editing ? '<button type="button" id="admin-edit-cancel" class="save-btn">إلغاء التعديل</button>' : ''}
        </div>
      </form>
      <p class="pillar-note" style="margin-top:8px">المدة بتتحسب من لحظة الحفظ.</p>
      <p id="admin-pass-status" class="pillar-note"></p>
    </div>

    <div class="slip-box">
      <div class="slip-head"><h3>🌐 السيرفر (Cloudflare) ${window.WORKER_URL ? '<span class="conf-badge conf-high">مربوط ✓</span>' : '<span class="conf-badge conf-low">مش مربوط</span>'}</h3></div>
      <p class="pillar-note" style="margin-bottom:10px">
        السيرفر بيفتح ميزتين: <b>بيانات xG</b> (جودة الفرص) للدوريات الخمسة الكبار،
        و<b>مزامنة تلقائية فورية</b> لكل المستخدمين. الصق رابط الـ Worker بتاعك
        (بيبقى بالشكل <span dir="ltr">https://predictor.xxx.workers.dev</span>) واضغط حفظ — بيتنشر في إعدادات الموقع لكل الأجهزة.
      </p>
      <form id="admin-worker-form" class="admin-form">
        <input type="url" id="admin-worker-url" dir="ltr" placeholder="https://predictor.xxx.workers.dev" value="${escapeHtml(window.WORKER_URL || '')}">
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <button type="submit" class="primary-btn" ${hasToken ? '' : 'disabled title="اربط GitHub الأول من تحت"'}>💾 احفظ وانشر</button>
          <button type="button" id="admin-worker-test" class="save-btn">🔌 اختبر الاتصال</button>
        </div>
      </form>
      <p id="admin-worker-status" class="pillar-note"></p>
    </div>

    <div class="slip-box">
      <div class="slip-head"><h3>🔗 ربط GitHub ${hasToken ? '<span class="conf-badge conf-high">متصل ✓</span>' : '<span class="conf-badge conf-low">مش متصل</span>'}</h3></div>
      <p class="pillar-note" style="margin-bottom:12px">
        عشان صفحة الإدارة تقدر تنشر التغيير على الموقع مباشرة (حتى من الفون)، محتاجة مفتاح GitHub — مرة واحدة بس.
        المفتاح بيتخزن <b>على الجهاز ده بس</b> ومش بيتبعت لأي حد غير GitHub نفسه.<br><br>
        <b>طريقة عمل المفتاح:</b><br>
        1) افتح <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" style="color:var(--gold)">صفحة إنشاء مفتاح جديد</a> (لازم تكون مسجل دخول بحسابك)<br>
        2) Token name: اكتب أي اسم (مثلاً predictor) · Expiration: اختار 1 year<br>
        3) Repository access → اختار Only select repositories → واختار <b>predictions</b><br>
        4) Permissions → Repository permissions → <b>Contents</b> → اختار <b>Read and write</b><br>
        5) اضغط Generate token وانسخ المفتاح والصقه هنا
      </p>
      <form id="admin-token-form" class="admin-form">
        <input type="password" id="admin-token" placeholder="${hasToken ? 'المفتاح محفوظ — الصق واحد جديد لو عايز تغيّره' : 'الصق المفتاح هنا (بيبدأ بـ github_pat_)'}">
        <button type="submit" class="primary-btn">💾 احفظ المفتاح</button>
        ${hasToken ? '<button type="button" id="admin-token-clear" class="save-btn">🗑 امسح المفتاح</button>' : ''}
      </form>
      <p id="admin-token-status" class="pillar-note"></p>
    </div>

    ${needsUpgrade ? `
    <div class="slip-box">
      <div class="slip-head"><h3>🛡️ ترقية الحماية</h3></div>
      <p class="pillar-note" style="margin-bottom:12px">
        في بصمات باسوردات لسه منشورة بالصيغة القديمة (SHA-256 السريعة) — واللي ممكن نظرياً تتخمن من الملف العام لو الباسورد ضعيف.
        الترقية بتعيد نشرها بصيغة <b>PBKDF2</b> (310 ألف تكرار) اللي بتخلي التخمين أبطأ بمئات آلاف المرات.<br>
        <b>خد بالك:</b> بعد الترقية كل المستخدمين هيسجلوا دخول من جديد بنفس باسورداتهم — بياناتهم مش هتتأثر.
      </p>
      <button id="admin-upgrade-security" class="primary-btn" ${hasToken ? '' : 'disabled title="اربط GitHub الأول من تحت"'}>🛡️ رقّي البصمات وانشر</button>
      <p id="admin-upgrade-status" class="pillar-note"></p>
    </div>` : ''}

    <div class="slip-box">
      <div class="slip-head"><h3>ℹ️ ملاحظات</h3></div>
      <p class="pillar-note">
        · كلمة سر <b>الأدمن</b> بتتغير من الكمبيوتر بس (بسكريبت change-password.ps1 أو عن طريق كلود) — للأمان.<br>
        · أي تغيير بياخد حوالي دقيقة عشان يوصل الموقع بعد النشر.<br>
        · الباسوردات بتتخزن <b>مشفرة بمفتاح مشتق من كلمة سر الأدمن</b> — عشان كده بتظهرلك في التعديل وأنت بس اللي تقدر تشوفها.<br>
        · <b>مهم:</b> لو غيّرت كلمة سر الأدمن، الباسوردات المحفوظة هتفضل شغالة عادي، بس مش هتظهر في التعديل تاني غير لما تكتبها من جديد وتحفظها.
      </p>
    </div>
  `;

  // عرض الباسورد الحالي في وضع التعديل (بعد فك تشفيره بمفتاح الأدمن)
  if (editing) {
    decryptPass(editing.enc).then(plain => {
      const elp = $('#admin-current-pass');
      if (!elp) return;
      if (plain) elp.innerHTML = `🔍 الباسورد الحالي: <b style="color:var(--gold); font-size:15px; letter-spacing:1px">${escapeHtml(plain)}</b> — سيب خانة كلمة السر فاضية لو مش عايز تغيّره`;
      else elp.innerHTML = '🔒 الباسورد ده متسجل من قبل ميزة العرض — لو عايز تشوفه بعد كده، اكتبه تاني في خانة كلمة السر واحفظ (أو سجل خروج وادخل تاني لو فاتح من جلسة قديمة)';
    });
  }

  // ربط سيرفر Cloudflare
  const workerStatus = $('#admin-worker-status');
  $('#admin-worker-test').onclick = async () => {
    const val = ($('#admin-worker-url').value.trim() || window.WORKER_URL || '').replace(/\/+$/, '');
    if (!val) { workerStatus.textContent = '⚠️ اكتب الرابط الأول'; return; }
    workerStatus.textContent = '⏳ بجرب الاتصال…';
    try {
      const res = await fetch(val + '/');
      const data = await res.json();
      if (data.service !== 'predictor-worker') throw new Error('الرد مش من سيرفر المُتنبئ');
      workerStatus.innerHTML = `✅ السيرفر شغال${data.kv ? ' والمزامنة جاهزة (KV مربوط)' : ' — <b>بس KV مش مربوط</b>: المزامنة التلقائية مش هتشتغل لحد ما تربطه من إعدادات الـ Worker'}`;
    } catch (err) { workerStatus.textContent = '❌ الاتصال فشل: ' + err.message + ' — اتأكد من الرابط وإن الـ Worker متنشر'; }
  };
  $('#admin-worker-form').onsubmit = async e => {
    e.preventDefault();
    const val = $('#admin-worker-url').value.trim().replace(/\/+$/, '');
    if (val && !/^https:\/\/.+/.test(val)) { workerStatus.textContent = '⚠️ الرابط لازم يبدأ بـ https://'; return; }
    workerStatus.textContent = '⏳ بنشر الإعداد…';
    const prev = window.WORKER_URL;
    window.WORKER_URL = val || undefined;
    try {
      await publishConfig(window.USER_PASSES || [], val ? 'ربط سيرفر Cloudflare' : 'فصل السيرفر');
      workerStatus.textContent = '✅ اتنشر — هيوصل كل الأجهزة خلال دقيقة';
      renderAdmin();
    } catch (err) {
      window.WORKER_URL = prev;
      workerStatus.textContent = '❌ فشل النشر: ' + err.message;
    }
  };

  $('#admin-token-form').onsubmit = async e => {
    e.preventDefault();
    const val = $('#admin-token').value.trim();
    if (!val) return;
    const encTok = await encryptPass(val);
    if (encTok) { localStorage.setItem(GH_TOKEN_ENC_KEY, encTok); localStorage.removeItem(GH_TOKEN_KEY); }
    else localStorage.setItem(GH_TOKEN_KEY, val); // مفيش مفتاح أدمن في الجلسة — هيتشفر أول ما تدخل تاني
    toast('✅ المفتاح اتحفظ على الجهاز ده' + (encTok ? ' (مشفر)' : ''));
    renderAdmin();
  };
  const clearBtn = $('#admin-token-clear');
  if (clearBtn) clearBtn.onclick = () => { localStorage.removeItem(GH_TOKEN_KEY); localStorage.removeItem(GH_TOKEN_ENC_KEY); toast('اتمسح المفتاح'); renderAdmin(); };

  // تعديل / حذف / مسح المنتهية
  area.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { adminEditIndex = +b.dataset.edit; renderAdmin(); });
  area.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const i = +b.dataset.del;
    const p = passes[i];
    if (!confirm(`متأكد إنك عايز تحذف باسورد «${p.label || 'مستخدم'}»؟ صاحبه مش هيعرف يدخل تاني.`)) return;
    await savePasses(passes.filter((_, x) => x !== i), `حذف باسورد ${p.label || 'مستخدم'}`);
  });
  const cleanBtn = $('#admin-clean-expired');
  if (cleanBtn) cleanBtn.onclick = () => savePasses(passes.filter(p => !passExpired(p)), 'مسح الباسوردات المنتهية');
  const cancelBtn = $('#admin-edit-cancel');
  if (cancelBtn) cancelBtn.onclick = () => { adminEditIndex = null; renderAdmin(); };

  // ترقية بصمات الباسوردات القديمة لـ PBKDF2
  const upgradeBtn = $('#admin-upgrade-security');
  if (upgradeBtn) upgradeBtn.onclick = async () => {
    if (!confirm('الترقية هتعيد نشر البصمات بصيغة أقوى، وكل المستخدمين هيسجلوا دخول من جديد بنفس باسورداتهم. نكمل؟')) return;
    const st = $('#admin-upgrade-status');
    upgradeBtn.disabled = true;
    st.textContent = '⏳ بجهز البصمات الجديدة…';

    const next = [];
    let skipped = 0;
    for (const p of passes) {
      if (p.salt) { next.push(p); continue; }
      const plain = await decryptPass(p.enc);
      if (!plain) { next.push(p); skipped++; continue; } // مش معروف نصه — بيفضل بالصيغة القديمة
      const salt = newSaltB64();
      next.push({ ...p, hash: await pbkdf2Text(plain, salt), salt, iter: PBKDF2_ITER });
    }

    let adminOverride = null;
    if (!window.ADMIN_SALT) {
      try { adminOverride = JSON.parse(sessionStorage.getItem('predictor_admin_upgrade')); } catch { adminOverride = null; }
      if (!adminOverride) {
        st.textContent = '⚠️ بصمة الأدمن الجديدة مش جاهزة في الجلسة دي — سجل خروج وادخل تاني وبعدين دوس الزرار ده';
        upgradeBtn.disabled = false;
        return;
      }
    }

    try {
      await publishConfig(next, 'ترقية الحماية لبصمات PBKDF2', adminOverride);
      sessionStorage.removeItem('predictor_admin_upgrade');
      toast('🛡️ اترقّت الحماية — هتشتغل على الموقع خلال دقيقة');
      if (skipped) alert(`ملحوظة: ${skipped} باسورد مش متسجل نصه المشفر فمعرفناش نرقّيه — عدّله واكتب كلمة السر تاني من الفورم وهيترقّى تلقائياً.`);
      renderAdmin();
    } catch (err) {
      st.textContent = '❌ فشل النشر: ' + err.message;
      upgradeBtn.disabled = false;
    }
  };

  // إضافة أو تعديل
  $('#admin-pass-form').onsubmit = async e => {
    e.preventDefault();
    const status = $('#admin-pass-status');
    const label = $('#admin-pass-label').value.trim() || 'مستخدم';
    const passVal = $('#admin-pass-value').value;
    const days = $('#admin-pass-days').value;

    if (!editing && !passVal) { status.textContent = '⚠️ اكتب كلمة السر'; return; }
    if (passVal && passVal.length < 4) { status.textContent = '⚠️ قصيرة أوي — 4 حروف على الأقل'; return; }

    let hash = editing?.hash, salt = editing?.salt ?? null, iter = editing?.iter ?? null;
    if (passVal) {
      status.textContent = '⏳ بجهز البصمة…';
      // اتأكد إنها مش كلمة سر الأدمن ولا باسورد تاني (البصمات مختلفة الـ salt فلازم نشتق لكل واحدة)
      const legacy = await sha256Text(passVal);
      const isAdmin = window.ADMIN_SALT
        ? (await pbkdf2Text(passVal, window.ADMIN_SALT, window.ADMIN_ITER || PBKDF2_ITER)) === window.ADMIN_HASH
        : legacy === window.ADMIN_HASH;
      if (isAdmin) { status.textContent = '⚠️ دي كلمة سر الأدمن — اختار كلمة تانية'; return; }
      for (let i = 0; i < passes.length; i++) {
        if (i === adminEditIndex) continue;
        const p = passes[i];
        const h = p.salt ? await pbkdf2Text(passVal, p.salt, p.iter || PBKDF2_ITER) : legacy;
        if (h === p.hash) { status.textContent = '⚠️ كلمة السر دي مستخدمة لباسورد تاني في القايمة'; return; }
      }
      salt = newSaltB64();
      iter = PBKDF2_ITER;
      hash = await pbkdf2Text(passVal, salt, iter);
    }

    const entry = {
      hash, salt, iter,
      label,
      created: editing ? editing.created : new Date().toISOString(),
      expires: days ? new Date(Date.now() + (+days) * 24 * 3600 * 1000).toISOString() : null,
      enc: passVal ? await encryptPass(passVal) : (editing ? editing.enc ?? null : null),
    };
    const next = [...passes];
    if (editing) next[adminEditIndex] = entry; else next.push(entry);
    await savePasses(next, editing ? `تعديل باسورد ${label}` : `إضافة باسورد ${label}`);
  };

  async function savePasses(next, actionLabel) {
    const status = $('#admin-pass-status');
    if (status) status.textContent = '⏳ بنشر التغيير على الموقع…';
    try {
      await publishConfig(next, actionLabel);
      adminEditIndex = null;
      renderAdmin();
      toast(`✅ تم (${actionLabel}) — هيشتغل على الموقع خلال دقيقة`);
    } catch (err) {
      const msg = err.message.includes('401') ? 'المفتاح غلط أو انتهت صلاحيته' : err.message.includes('403') ? 'المفتاح مش معاه صلاحية Contents على الريبو' : err.message.includes('مفيش مفتاح') ? err.message : 'HTTP: ' + err.message;
      if (status) status.textContent = '❌ فشل النشر: ' + msg;
      else toast('❌ فشل النشر: ' + msg);
    }
  }
}

// نشر إعدادات الباسوردات على GitHub (بيحدّث docs/config.js في الريبو)
// adminOverride: {hash, salt, iter} لو بنرقّي بصمة الأدمن نفسها لـ PBKDF2
async function publishConfig(newPasses, actionLabel, adminOverride = null) {
  const admin = adminOverride || { hash: window.ADMIN_HASH, salt: window.ADMIN_SALT || null, iter: window.ADMIN_ITER || null };
  const content = [
    '// إعدادات كلمات السر (بصمات PBKDF2 — والقديمة SHA-256 لحد ما تترقّى)',
    '// ADMIN_HASH: كلمة سر الأدمن — USER_PASSES: باسوردات المستخدمين (كل واحد باسم ومدة صلاحية)',
    `window.ADMIN_HASH = '${admin.hash}';`,
    ...(admin.salt ? [`window.ADMIN_SALT = '${admin.salt}';`, `window.ADMIN_ITER = ${admin.iter || PBKDF2_ITER};`] : []),
    ...(window.WORKER_URL ? [`window.WORKER_URL = '${window.WORKER_URL}';`] : []),
    `window.USER_PASSES = ${JSON.stringify(newPasses, null, 2)};`,
    '',
  ].join('\n');
  await ghPutFile(GH_CONFIG_PATH, content, `${actionLabel} — من صفحة الإدارة`);
  window.USER_PASSES = newPasses;
  if (adminOverride) {
    window.ADMIN_HASH = adminOverride.hash;
    window.ADMIN_SALT = adminOverride.salt;
    window.ADMIN_ITER = adminOverride.iter;
    // نحدّث الجلسة الحالية عشان الأدمن ميتطردش بعد الترقية
    try {
      const s = JSON.parse(sessionStorage.getItem('predictor_auth_v1'));
      if (s) { s.a = adminOverride.hash; sessionStorage.setItem('predictor_auth_v1', JSON.stringify(s)); window.AUTH_HASH = adminOverride.hash; }
    } catch { /* جلسة قديمة — هيسجل دخول تاني */ }
  }
}

function updateAdminNav() {
  $('#nav-admin').classList.toggle('hidden', window.AUTH_ROLE !== 'admin');
}

function logout() {
  sessionStorage.removeItem('predictor_auth_v1');
  sessionStorage.removeItem('predictor_admin_key');
  location.reload(); // هيرجع لشاشة القفل
}

// ---------- إشعار خفيف ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- التنقل والتواريخ ----------
function switchView(view) {
  state.currentView = view;
  $('#view-matches').classList.toggle('hidden', view !== 'matches');
  $('#view-slips').classList.toggle('hidden', view !== 'slips');
  $('#view-stats').classList.toggle('hidden', view !== 'stats');
  $('#view-elo').classList.toggle('hidden', view !== 'elo');
  $('#view-admin').classList.toggle('hidden', view !== 'admin');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'slips') renderSlips();
  if (view === 'stats') renderStats();
  if (view === 'elo') renderEloBoard();
  if (view === 'admin') renderAdmin();
}

function setDate(d) {
  state.date = d;
  state.mode = 'day';
  state.leagueView = null;
  state.leagueFilter = null;
  $('#date-input').value = fmtDateISO(d);
  renderDateChips();
  renderLeagueBar();
  loadMatches();
}

function renderDateChips() {
  const bar = $('#date-chips');
  bar.innerHTML = '';
  const today = new Date();
  const labels = ['أمس', 'النهارده', 'بكرة', 'بعد بكرة'];
  for (let i = -1; i <= 4; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    const label = labels[i + 1] || d.toLocaleDateString('ar-EG', { weekday: 'long' });
    const c = el('button', 'chip date-chip' + (fmtDateISO(d) === fmtDateISO(state.date) ? ' active' : ''), label);
    c.onclick = () => setDate(d);
    bar.appendChild(c);
  }
}

// ---------- تشغيل ----------
document.addEventListener('DOMContentLoaded', () => {
  $('#date-input').onchange = e => { const [y, mo, da] = e.target.value.split('-').map(Number); if (y) setDate(new Date(y, mo - 1, da)); };
  $('#btn-top-picks').onclick = analyzeAll;
  $('#btn-value-picks').onclick = showValuePicks;
  $('#btn-auto-slip').onclick = openSlipGenerator;
  // PWA: الموقع يتسطب كتطبيق ويفتح حتى لو النت فاصل (آخر نسخة متخزنة)
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { /* مش متاح */ });
  document.querySelectorAll('.nav-btn').forEach(b => b.onclick = () => switchView(b.dataset.view));
  $('#modal-close').onclick = () => $('#modal').classList.add('hidden');
  $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };
  updateAdminNav();
  migrateLegacyStorage();
  document.addEventListener('predictor-authed', () => { updateAdminNav(); migrateLegacyStorage(); autoLearnTick(); });
  $('#nav-logout').onclick = logout;
  seedSharedElo();          // القاعدة المشتركة المتحدثة ليلياً من GitHub
  setTimeout(autoLearnTick, 20 * 1000);         // تعلم صامت بعد ما الصفحة تحمل
  setInterval(autoLearnTick, 15 * 60 * 1000);   // وكل شوية طول ما الموقع فاتح
  setTimeout(() => autoSyncTick(true), 5 * 1000);   // مزامنة تلقائية مع السيرفر (لو مربوط)
  setInterval(() => autoSyncTick(false), 10 * 60 * 1000);
  document.addEventListener('predictor-authed', () => setTimeout(() => autoSyncTick(true), 2000));
  setDate(new Date());
});

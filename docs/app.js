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
const SLIPS_KEY = 'predictor_slips_v1';
const AUTOLOG_KEY = 'predictor_autolog_v1';
const LEARNED_KEY = 'predictor_learned_v1';
const STANDINGS_KEY = 'predictor_standings_v1';

const loadSlips = () => store.get(SLIPS_KEY, []);
const saveSlips = s => store.set(SLIPS_KEY, s);
const loadLearned = () => store.get(LEARNED_KEY, { weights: null, buckets: {}, pillars: {}, settled: 0 });

// معاملات المعايرة من سجل الدقة: لو ثقة 80% بتصيب 65% فعلاً → نزّلها
function calibFactors() {
  const learned = loadLearned();
  const mids = { '50': 55, '60': 65, '70': 75, '80': 85, '90': 92 };
  const out = {};
  for (const [b, mid] of Object.entries(mids)) {
    const s = learned.buckets[b];
    if (s && s.total >= 8) {
      out[b] = Math.max(0.75, Math.min(1.12, (s.hit / s.total) * 100 / mid));
    }
  }
  return Object.keys(out).length ? out : null;
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
  const matches = [];
  for (const { lg, events } of results) {
    for (const ev of events) {
      if (seen.has(ev.id)) continue;
      const local = new Date(ev.date);
      if (fmtDateISO(local) !== targetISO) continue;
      seen.add(ev.id);
      const m = toMatch(ev, lg.code);
      if (m) matches.push(m);
    }
  }
  matches.sort((a, b) => new Date(a.date) - new Date(b.date));
  state.matches = matches;
  renderMatches();
}

// تحويل حدث ESPN لكائن ماتش موحد
// بطولات بتتلعب على ملاعب محايدة — مفيش ميزة أرض حتى لو البيانات سجلت "صاحب أرض" شكلي
const NEUTRAL_LEAGUES = new Set(['fifa.world', 'uefa.euro', 'conmebol.america', 'caf.nations']);

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
  matches.sort((a, b) => new Date(a.date) - new Date(b.date));
  state.matches = matches;
  renderLeagueMatches();
}

// فهرس آخر التحليلات المحفوظة عشان الكروت تفتكرها بعد قفل الصفحة
function refreshAutologIndex() {
  state.autologByEvent = Object.fromEntries(store.get(AUTOLOG_KEY, []).map(r => [r.id, r]));
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

  const [summary, oppStrength] = await Promise.all([
    fetchJSON(`${API}/${m.league}/summary?event=${m.id}`),
    getOppStrength(m.league),
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
  const log = store.get(AUTOLOG_KEY, []);
  const idx = log.findIndex(x => x.id === m.id);
  const rec = {
    id: m.id, league: m.league, kickoff: m.date,
    home: m.home.name, away: m.away.name,
    best: { label: a.best.pickLabel, conf: a.best.conf },
    markets: a.markets.map(mk => ({ market: mk.market, pickCode: mk.pick, prob: +mk.prob.toFixed(3), conf: mk.conf })),
    leans: a.pillarLeans,
    status: 'pending', score: null,
  };
  if (idx >= 0) { if (log[idx].status === 'pending') log[idx] = rec; }
  else log.push(rec);
  while (log.length > 400) {
    const i = log.findIndex(x => x.status !== 'pending');
    log.splice(i >= 0 ? i : 0, 1);
  }
  store.set(AUTOLOG_KEY, log);
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
  const topScore = a.topScores?.[0];

  body.innerHTML = `
    <div class="an-header">
      <div class="an-team"><img src="${m.home.logo || ''}" onerror="this.style.visibility='hidden'"><h3>${escapeHtml(m.home.name)}</h3></div>
      <div class="an-vs">
        <div class="an-time">${m.state === 'pre' ? fmtTime(m.date) : (m.state === 'in' ? 'مباشر' : `${m.home.score} - ${m.away.score}`)}</div>
        <div class="an-league">${escapeHtml(m.leagueName)}${m.neutralSite ? ' · ملعب محايد 🏟' : ''}</div>
      </div>
      <div class="an-team"><img src="${m.away.logo || ''}" onerror="this.style.visibility='hidden'"><h3>${escapeHtml(m.away.name)}</h3></div>
    </div>

    <div class="an-strength">
      <span class="st-num">${a.strength.home}</span>
      <div class="st-bar"><div class="st-fill" style="width:${(a.strength.home / (a.strength.home + a.strength.away)) * 100}%"></div></div>
      <span class="st-num">${a.strength.away}</span>
    </div>
    <p class="st-caption">مؤشر القوة الإجمالي (${Math.round(a.quality * 100)}% اكتمال بيانات)</p>

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
          أهداف متوقعة: ${a.expGoals.home.toFixed(1)} - ${a.expGoals.away.toFixed(1)}${topScore ? ` · النتيجة الأكثر احتمالاً: <b>${topScore.h} - ${topScore.a}</b> (${Math.round(topScore.p * 100)}%)` : ''}
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

// ---------- أضمن اختيارات اليوم ----------
async function analyzeAll() {
  if (state.bulkRunning) return;
  const pre = state.matches.filter(m => m.state === 'pre');
  if (!pre.length) { toast('مفيش ماتشات جاية النهارده للتحليل'); return; }

  state.bulkRunning = true;
  const btn = $('#btn-top-picks');
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
  btn.textContent = '⚡ أضمن اختيارات اليوم';

  const ranked = pre
    .map(m => ({ m, a: state.analysisCache[m.id] }))
    .filter(x => x.a)
    .sort((x, y) => y.a.best.conf - x.a.best.conf)
    .slice(0, 5);

  const top = $('#top-picks');
  top.classList.remove('hidden');
  top.innerHTML = '<h2 class="tp-title">⚡ أضمن اختيارات اليوم</h2>';
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
  await Promise.all([...need.values()].map(async ({ league, dk }) => {
    try {
      const data = await fetchJSON(`${API}/${league}/scoreboard?dates=${dk}`, { cache: false });
      for (const ev of (data.events || [])) {
        if (ev.status?.type?.state !== 'post') continue;
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === 'home');
        const away = comp?.competitors?.find(c => c.homeAway === 'away');
        if (home && away) eventScores[ev.id] = { h: parseInt(home.score, 10), a: parseInt(away.score, 10) };
      }
    } catch { /* تجاهل */ }
  }));
  return eventScores;
}

async function refreshResults() {
  const btn = $('#btn-refresh-results');
  btn.disabled = true; btn.textContent = '⏳ بجيب النتائج…';
  const slips = loadSlips();
  const pending = slips.flatMap(s => s.items).filter(i => i.status === 'pending' && new Date(i.kickoff).getTime() < Date.now() - 2 * 3600 * 1000);
  const eventScores = await fetchScores(pending);

  let updated = 0;
  for (const slip of slips) {
    for (const it of slip.items) {
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
  toast(updated ? `✅ اتحدثت نتايج ${updated} توقع` : 'مفيش نتايج جديدة لسه');
}

// ---------- صفحة الدقة والتعلم الذاتي ----------
function renderStats() {
  const area = $('#stats-area');
  const log = store.get(AUTOLOG_KEY, []);
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
    <p class="pillar-note" style="margin-top:10px">النظام بيتابع أنهي عمود بيصيب أكتر في توقع نتيجة الماتش، وبيزود وزنه تدريجياً (بعد 15 ماتش محسوبة على الأقل).</p>
  `;
  area.appendChild(wBox);

  if (!log.length) area.appendChild(el('div', 'empty-state', '<div class="empty-icon">🧠</div><h3>لسه مفيش سجل</h3><p>كل ماتش بتحلله بيتسجل هنا تلقائياً — وبعد ما يخلص دوس "حدّث وتعلّم" عشان النظام يقيس نفسه ويتحسن.</p>'));
}

async function learnFromResults() {
  const btn = $('#btn-learn');
  btn.disabled = true; btn.textContent = '⏳ بجيب النتائج وبتعلم…';

  const log = store.get(AUTOLOG_KEY, []);
  const pending = log.filter(x => x.status === 'pending' && new Date(x.kickoff).getTime() < Date.now() - 2 * 3600 * 1000);
  const eventScores = await fetchScores(pending);

  const learned = loadLearned();
  let newly = 0;
  for (const rec of log) {
    if (rec.status !== 'pending') continue;
    const sc = eventScores[rec.id];
    if (!sc || isNaN(sc.h) || isNaN(sc.a)) continue;

    // معايرة الثقة: كل سوق اتقيم حسب دلو ثقته
    for (const mk of rec.markets) {
      const ok = Engine.evaluatePick({ market: mk.market, pickCode: mk.pickCode }, sc.h, sc.a);
      if (ok === null) continue;
      const b = Engine.bucketOf(mk.conf);
      learned.buckets[b] ??= { hit: 0, total: 0 };
      learned.buckets[b].total++;
      if (ok) learned.buckets[b].hit++;
    }

    // دقة الأعمدة: ميل العمود طابق نتيجة الماتش؟
    const actual = sc.h > sc.a ? 'H' : sc.h < sc.a ? 'A' : 'D';
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

  store.set(AUTOLOG_KEY, log);
  store.set(LEARNED_KEY, learned);
  state.analysisCache = {}; // التحليلات الجاية هتستخدم الأوزان والمعايرة الجديدة
  renderStats();
  toast(newly ? `🧠 النظام اتعلم من ${newly} ماتش جديد` : 'مفيش ماتشات جديدة خلصت لسه');
}

// ---------- صفحة الإدارة (للأدمن بس) ----------
const GH_OWNER = 'abanoub-maged145';
const GH_REPO = 'predictions';
const GH_CONFIG_PATH = 'docs/config.js';
const GH_TOKEN_KEY = 'predictor_gh_token';

const sha256Text = async text => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};

function renderAdmin() {
  const area = $('#admin-area');
  const hasToken = !!localStorage.getItem(GH_TOKEN_KEY);
  area.innerHTML = `
    <div class="slip-box">
      <div class="slip-head"><h3>🔑 كلمة سر المستخدمين العاديين</h3></div>
      <p class="pillar-note" style="margin-bottom:12px">
        دي الكلمة اللي بيدخل بيها أي حد غيرك. لما تغيّرها وتنشر،
        <b>كل المستخدمين هيتسجل خروجهم تلقائياً</b> وهيحتاجوا الكلمة الجديدة.
        كلمة سر الأدمن بتاعتك مش بتتأثر.
      </p>
      <form id="admin-pass-form" class="admin-form">
        <input type="password" id="admin-new-pass" placeholder="كلمة السر الجديدة للمستخدمين" autocomplete="new-password">
        <input type="password" id="admin-new-pass2" placeholder="تأكيد كلمة السر" autocomplete="new-password">
        <button type="submit" class="primary-btn" ${hasToken ? '' : 'disabled title="اربط GitHub الأول من تحت"'}>🚀 غيّر وانشر</button>
      </form>
      <p id="admin-pass-status" class="pillar-note"></p>
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

    <div class="slip-box">
      <div class="slip-head"><h3>ℹ️ ملاحظات</h3></div>
      <p class="pillar-note">
        · كلمة سر <b>الأدمن</b> بتتغير من الكمبيوتر بس (بسكريبت change-password.ps1 أو عن طريق كلود) — للأمان.<br>
        · التغيير بياخد حوالي دقيقة عشان يوصل الموقع بعد النشر.<br>
        · لو نسيت كلمة سر المستخدمين، غيّرها من هنا عادي — مفيش حاجة بتضيع.
      </p>
    </div>
  `;

  $('#admin-token-form').onsubmit = e => {
    e.preventDefault();
    const val = $('#admin-token').value.trim();
    if (!val) return;
    localStorage.setItem(GH_TOKEN_KEY, val);
    toast('✅ المفتاح اتحفظ على الجهاز ده');
    renderAdmin();
  };
  const clearBtn = $('#admin-token-clear');
  if (clearBtn) clearBtn.onclick = () => { localStorage.removeItem(GH_TOKEN_KEY); toast('اتمسح المفتاح'); renderAdmin(); };

  $('#admin-pass-form').onsubmit = async e => {
    e.preventDefault();
    const p1 = $('#admin-new-pass').value, p2 = $('#admin-new-pass2').value;
    const status = $('#admin-pass-status');
    if (!p1) { status.textContent = '⚠️ اكتب كلمة السر الجديدة'; return; }
    if (p1 !== p2) { status.textContent = '⚠️ الكلمتين مش متطابقتين'; return; }
    if (p1.length < 4) { status.textContent = '⚠️ قصيرة أوي — 4 حروف على الأقل'; return; }
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = '⏳ بنشر التغيير…';
    try {
      await publishUserPassword(p1);
      status.innerHTML = '✅ <b>تم!</b> كلمة السر الجديدة هتشتغل على الموقع خلال دقيقة، وكل المستخدمين هيتطلب منهم الكلمة الجديدة.';
      $('#admin-new-pass').value = ''; $('#admin-new-pass2').value = '';
    } catch (err) {
      status.textContent = '❌ فشل النشر: ' + err.message + (err.message.includes('401') ? ' — المفتاح غلط أو انتهت صلاحيته' : err.message.includes('403') ? ' — المفتاح مش معاه صلاحية Contents على الريبو' : '');
    }
    btn.disabled = false; btn.textContent = '🚀 غيّر وانشر';
  };
}

async function publishUserPassword(newPass) {
  const token = localStorage.getItem(GH_TOKEN_KEY);
  if (!token) throw new Error('مفيش مفتاح GitHub محفوظ');
  const newHash = await sha256Text(newPass);
  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_CONFIG_PATH}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' };

  const cur = await fetch(api, { headers });
  if (!cur.ok) throw new Error('HTTP ' + cur.status);
  const curData = await cur.json();

  const content = [
    '// إعدادات كلمات السر (مخزنة كبصمات SHA-256)',
    '// ADMIN_HASH: كلمة سر الأدمن (بتفتح تبويب الإدارة) — USER_HASH: كلمة سر المستخدمين العاديين',
    `window.ADMIN_HASH = '${window.ADMIN_HASH}';`,
    `window.USER_HASH = '${newHash}';`,
    '',
  ].join('\n');
  const b64 = btoa(unescape(encodeURIComponent(content)));

  const res = await fetch(api, {
    method: 'PUT', headers,
    body: JSON.stringify({ message: 'تغيير كلمة سر المستخدمين من صفحة الإدارة', content: b64, sha: curData.sha }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  window.USER_HASH = newHash;
}

function updateAdminNav() {
  $('#nav-admin').classList.toggle('hidden', window.AUTH_ROLE !== 'admin');
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
  $('#view-admin').classList.toggle('hidden', view !== 'admin');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'slips') renderSlips();
  if (view === 'stats') renderStats();
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
  document.querySelectorAll('.nav-btn').forEach(b => b.onclick = () => switchView(b.dataset.view));
  $('#modal-close').onclick = () => $('#modal').classList.add('hidden');
  $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };
  updateAdminNav();
  document.addEventListener('predictor-authed', updateAdminNav);
  setDate(new Date());
});

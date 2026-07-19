// ============================================================
// سيرفر المُتنبئ — Cloudflare Worker
// بيقدم للموقع حاجتين مش ممكنين من المتصفح مباشرة:
//   1) /xg?league=eng.1  → بيانات xG (الأهداف المتوقعة من جودة الفرص)
//      لفرق الدوريات الخمسة الكبار من Understat — بكاش 6 ساعات
//   2) /sync/<id>        → مزامنة تلقائية لبيانات المستخدمين (GET/PUT)
//      البيانات بتوصل مشفرة AES-GCM من المتصفح — السيرفر مبيشوفش محتواها
//
// النشر: الصق الملف ده في محرر الـ Worker على dash.cloudflare.com
// واربط KV namespace باسم "KV" من الإعدادات (للمزامنة بس — الـ xG شغال من غيرها)
// ============================================================

const UNDERSTAT = {
  'eng.1': 'EPL',
  'esp.1': 'La_liga',
  'ita.1': 'Serie_A',
  'ger.1': 'Bundesliga',
  'fra.1': 'Ligue_1',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });

// فك ترميز \x7B... اللي Understat بيحط بيه الداتا جوه الصفحة
const decodeHex = s => s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

// أسماء الدوريات زي ما بتظهر في اختيارات صفحة Understat
const UNDERSTAT_NAME = { EPL: 'EPL', La_liga: 'La liga', Serie_A: 'Serie A', Bundesliga: 'Bundesliga', Ligue_1: 'Ligue 1' };

// فهم مرن لأي صيغة رد: بندور على قايمة فرق فيها اسم + تاريخ ماتشات أو إجماليات xG
function collectTeamArrays(node, depth = 0, out = []) {
  if (!node || typeof node !== 'object' || depth > 4) return out;
  const arr = Array.isArray(node) ? node : Object.values(node);
  if (arr.length >= 6 && arr.every(t => t && typeof t === 'object' && (t.title || t.name || t.team_name))) {
    out.push(arr);
    return out;
  }
  for (const v of arr) collectTeamArrays(v, depth + 1, out);
  return out;
}
function teamsFrom(j) {
  for (const arr of collectTeamArrays(j)) {
    const teams = arr.map(t => {
      const name = t.title || t.name || t.team_name;
      const hist = Array.isArray(t.history) ? t.history : null;
      if (hist && hist.length) {
        const n = hist.length;
        const sum = k => hist.reduce((s, g) => s + (parseFloat(g[k]) || 0), 0);
        return { name, n, xg: +(sum('xG') / n).toFixed(2), xga: +(sum('xGA') / n).toFixed(2) };
      }
      const n = parseInt(t.matches ?? t.M ?? t.games, 10);
      const xg = parseFloat(t.xG ?? t.xg), xga = parseFloat(t.xGA ?? t.xga);
      if (n > 0 && !isNaN(xg) && !isNaN(xga)) return { name, n, xg: +(xg / n).toFixed(2), xga: +(xga / n).toFixed(2) };
      return null;
    }).filter(t => t && t.name && t.n >= 3);
    if (teams.length >= 6) return teams;
  }
  return null;
}

// الاكتشاف الذاتي: نقرا ملف league.min.js بتاعهم، نطلع منه أسماء نقط البيانات،
// ونجربها POST وGET لحد ما واحدة ترجع قايمة فرق مفهومة
async function discoverTeams(slug, { verbose = false } = {}) {
  const pageRes = await fetch(`https://understat.com/league/${slug}`, { headers: BROWSER_HEADERS });
  const page = await pageRes.text();

  // القديمة: البيانات جوه الصفحة نفسها
  const inline = page.match(/teamsData\s*=\s*JSON\.parse\('([^']+)'\)/) || page.match(/teamsData\s*=\s*JSON\.parse\("([^"]+)"\)/);
  if (inline) {
    const teams = teamsFrom(JSON.parse(decodeHex(inline[1])));
    if (teams) return { teams, endpoint: 'inline-teamsData', tried: [] };
  }

  const season = (page.match(/name="season"[\s\S]{0,400}?value="(\d{4})"\s+selected/) || [])[1] || String(new Date().getFullYear());
  const leagueName = UNDERSTAT_NAME[slug] || slug.replace(/_/g, ' ');
  const enc = encodeURIComponent(leagueName);

  // نقرا ملف league.min.js ونستخرج منه نمط نداء البيانات الحقيقي
  // (اكتشفناه: getLeagueData/"+league+"/"+season). بندوّر على أي url:"..."+league+...
  const urlBuilders = [];
  const jsSrc = (page.match(/src=["']([^"']*league[^"']*\.js[^"']*)["']/i) || [])[1];
  let jsSnippets = [];
  if (jsSrc) {
    try {
      const js = await (await fetch(new URL(jsSrc, 'https://understat.com/').href, { headers: { ...BROWSER_HEADERS, 'Accept': '*/*' } })).text();
      // نمط: url:"PREFIX/"+league+"/"+season  →  PREFIX/{league}/{season}
      for (const m of js.matchAll(/url\s*:\s*["']([A-Za-z0-9_\-/]+\/)["']\s*\+\s*league\s*\+\s*["']\/["']\s*\+\s*season/g)) {
        urlBuilders.push({ url: `https://understat.com/${m[1]}${enc}/${season}`, label: `GET ${m[1]}{league}/{season}` });
      }
      // نمط عام: url:"SOMEPATH"  لأي مسار فيه get/data/league/team
      for (const m of js.matchAll(/url\s*:\s*["']([A-Za-z0-9_\-/]{4,60})["']/g)) {
        if (/get|data|league|team|stat/i.test(m[1]) && !/\.(js|css|png)/.test(m[1])) {
          const base = m[1].replace(/\/$/, '');
          urlBuilders.push({ url: `https://understat.com/${base}/${enc}/${season}`, label: `GET ${base}/{league}/{season}` });
        }
      }
      if (verbose) {
        for (const m of js.matchAll(/\$\.(ajax|post|get|getJSON)\s*\(/g)) {
          jsSnippets.push(js.slice(Math.max(0, m.index - 60), m.index + 500));
          if (jsSnippets.length >= 5) break;
        }
      }
    } catch { /* الملف مش متاح */ }
  }
  // النقطة المعروفة الأكيدة أول القايمة (اتأكدنا منها من الـ jsSnippets)
  urlBuilders.unshift({ url: `https://understat.com/getLeagueData/${enc}/${season}`, label: 'GET getLeagueData/{league}/{season}' });

  const tried = [];
  const seen = new Set();
  for (const { url: target, label } of urlBuilders) {
    if (seen.has(target)) continue;
    seen.add(target);
    try {
      const res = await fetch(target, {
        headers: {
          ...BROWSER_HEADERS,
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `https://understat.com/league/${slug}`,
        },
      });
      const text = await res.text();
      if (verbose) tried.push({ url: label, status: res.status, sample: text.slice(0, 200) });
      if (!res.ok) continue;
      const j = JSON.parse(text);
      const teams = teamsFrom(j.teams ?? j); // البيانات جوه data.teams
      if (teams) return { teams, endpoint: label, tried, jsSnippets };
    } catch { if (verbose) tried.push({ url: label, status: 'err' }); }
    if (seen.size >= 14) break;
  }
  return { teams: null, endpoint: null, tried, jsSnippets, pageLength: page.length };
}

async function xgHandler(url) {
  const league = url.searchParams.get('league');
  const slug = UNDERSTAT[league];
  if (!slug) return json({ error: 'league not supported', supported: Object.keys(UNDERSTAT) }, 400);

  // كاش 6 ساعات — بيانات xG الموسمية مش بتتغير غير بعد الجولات
  const cacheKey = new Request(`https://cache.predictor/xg/${slug}`);
  const cache = globalThis.caches?.default;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  // الاكتشاف الذاتي: بيقرا صفحة Understat وملف league.min.js ويلاقي نقطة البيانات لوحده
  const { teams, endpoint } = await discoverTeams(slug);
  if (!teams) {
    return json({ error: 'معرفناش نجيب بيانات xG — Understat غيّر مكان البيانات. جرّب /xg-debug?league=' + league + '&verbose=1' }, 502);
  }

  const out = json({ league, source: 'understat', endpoint, fetchedAt: new Date().toISOString(), teams },
    200, { 'Cache-Control': 's-maxage=21600' });
  if (cache) await cache.put(cacheKey, out.clone());
  return out;
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://understat.com/',
};

// أداة استكشاف: Understat غيّروا تصميمهم والبيانات بقت بتيجي من API منفصل —
// النقطة دي بتفتش صفحتهم وملفات الجافاسكريبت بتاعتهم عن مسارات الـ API
async function xgDebug(url) {
  const path = url.searchParams.get('path');
  if (path) {
    // جرّب مسار معين على understat.com وشوف بيرجع إيه
    const res = await fetch(`https://understat.com${path}`, { headers: { ...BROWSER_HEADERS, 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest' } });
    const text = await res.text();
    return json({ status: res.status, type: res.headers.get('content-type'), length: text.length, sample: text.slice(0, 1500) });
  }
  const slug = UNDERSTAT[url.searchParams.get('league')] || 'EPL';

  // وضع verbose: شغّل الاكتشاف الذاتي وورّي كل نقطة اتجربت ورجعت إيه
  if (url.searchParams.get('verbose')) {
    const r = await discoverTeams(slug, { verbose: true });
    return json({
      found: !!r.teams, endpoint: r.endpoint,
      teamsCount: r.teams?.length || 0,
      sampleTeam: r.teams?.[0] || null,
      jsSnippets: r.jsSnippets, tried: r.tried, pageLength: r.pageLength,
    });
  }

  const res = await fetch(`https://understat.com/league/${slug}`, { headers: BROWSER_HEADERS });
  const html = await res.text();

  // مقاطع حوالين كلمة معينة — عشان نشوف الجداول ونداءات الـ ajax جوه الصفحة
  const around = (re, radius, max) => {
    const out = [];
    for (const m of html.matchAll(re)) {
      out.push(html.slice(Math.max(0, m.index - 80), m.index + radius).replace(/\s+/g, ' '));
      if (out.length >= max) break;
    }
    return out;
  };

  return json({
    status: res.status, length: html.length,
    tables: around(/<table/gi, 1200, 2),                                  // جدول xG لو متحطط في الصفحة
    ajax: around(/\$\.(ajax|get|post|getJSON)|fetch\(|XMLHttpRequest/gi, 700, 4), // نداءات البيانات
    inlineScripts: around(/<script(?![^>]*src)[^>]*>/gi, 900, 3),         // السكربتات المكتوبة جوه الصفحة
    bodyTail: html.slice(-1500).replace(/\s+/g, ' '),                     // آخر الصفحة — غالباً فيها كود التحميل
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (url.pathname === '/') return json({ ok: true, service: 'predictor-worker', version: 2, autodeploy: true, kv: !!env.KV });
      if (url.pathname === '/xg') return await xgHandler(url);
      if (url.pathname === '/xg-debug') return await xgDebug(url);

      const m = url.pathname.match(/^\/sync\/([0-9a-f]{10})$/);
      if (m) {
        if (!env.KV) return json({ error: 'اربط KV namespace باسم KV من إعدادات الـ Worker الأول' }, 500);
        const key = 'sync:' + m[1];
        if (req.method === 'GET') {
          const v = await env.KV.get(key);
          return v
            ? new Response(v, { headers: { ...CORS, 'Content-Type': 'application/json' } })
            : json({ error: 'not found' }, 404);
        }
        if (req.method === 'PUT') {
          const body = await req.text();
          if (body.length > 2000000) return json({ error: 'too large' }, 413);
          await env.KV.put(key, body);
          return json({ ok: true });
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

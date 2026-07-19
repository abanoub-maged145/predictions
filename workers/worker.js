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

  // هيدرز متصفح كاملة — Understat بيرفض الطلبات اللي شكلها مش متصفح حقيقي
  const res = await fetch(`https://understat.com/league/${slug}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://understat.com/',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  if (!res.ok) return json({ error: 'understat http ' + res.status }, 502);
  const html = await res.text();
  // بندور على teamsData بأي صيغة اقتباس
  const m = html.match(/teamsData\s*=\s*JSON\.parse\('([^']+)'\)/) ||
            html.match(/teamsData\s*=\s*JSON\.parse\("([^"]+)"\)/);
  if (!m) {
    // تشخيص: نرجع عنوان الصفحة اللي رجعت عشان نعرف هي صفحة حماية ولا الشكل اتغير
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    return json({
      error: 'understat blocked or format changed',
      pageTitle: title.trim().slice(0, 120),
      pageLength: html.length,
      hasTeamsWord: html.includes('teamsData'),
    }, 502);
  }

  const data = JSON.parse(decodeHex(m[1]));
  const teams = Object.values(data).map(t => {
    const hist = t.history || [];
    const n = hist.length;
    const sum = k => hist.reduce((s, g) => s + (parseFloat(g[k]) || 0), 0);
    return {
      name: t.title,
      n,
      xg: n ? +(sum('xG') / n).toFixed(2) : null,   // أهداف متوقعة لصالحه لكل ماتش
      xga: n ? +(sum('xGA') / n).toFixed(2) : null, // أهداف متوقعة عليه لكل ماتش
    };
  }).filter(t => t.n >= 3);

  const out = json({ league, source: 'understat', fetchedAt: new Date().toISOString(), teams },
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
      if (url.pathname === '/') return json({ ok: true, service: 'predictor-worker', kv: !!env.KV });
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

// ============================================================
// المحدّث الليلي لقاعدة التقييمات — بيشتغل بأكشن GitHub كل ليلة:
// بيجيب نتايج آخر 4 أيام من كل البطولات، وبيحدّث docs/data/elo.json
// اللي كل الأجهزة بتبدأ منه. النظام بيتعلم حتى والموقع مقفول.
//
// مهم: حسابات Elo والهجوم/الدفاع هنا لازم تفضل مطابقة لنسخة المتصفح
// في docs/app.js (EloDB.record) — لو عدلت هنا عدل هناك والعكس.
// ============================================================

const API = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const LEAGUES = [
  'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1',
  'uefa.champions', 'uefa.europa', 'ksa.1',
  'caf.champions', 'caf.confed', 'usa.1',
  'fifa.world', 'uefa.euro', 'uefa.nations', 'fifa.friendly',
  'caf.nations', 'conmebol.america',
];
const NEUTRAL = new Set(['fifa.world', 'uefa.euro', 'conmebol.america', 'caf.nations']);
const DATA_PATH = new URL('../docs/data/elo.json', import.meta.url);

const clampN = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const dayKey = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

// نفس ضمانة الموقع: الماتش لازم يكون خلص تماماً — مش واقف على وقت إضافي،
// ومش مؤجل ولا ملغي ولا موقوف
const isFinal = st => !!st && st.state === 'post' && st.completed !== false &&
  !/POSTPONED|CANCEL|ABANDON|SUSPEND|DELAY/i.test(st.name || '');

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

let db;
try { db = JSON.parse(readFileSync(DATA_PATH, 'utf8')); }
catch { db = { teams: {}, done: {}, order: [] } }
db.teams ??= {}; db.done ??= {}; db.order ??= [];

// نفس معادلات EloDB.record في docs/app.js
function record(m) {
  if (db.done[m.id]) return false;
  const hs = parseInt(m.home.score, 10), as = parseInt(m.away.score, 10);
  if (isNaN(hs) || isNaN(as)) return false;
  const h = db.teams[String(m.home.id)] ??= { r: 1500, n: 0 };
  const a = db.teams[String(m.away.id)] ??= { r: 1500, n: 0 };
  const exp = 1 / (1 + Math.pow(10, -((h.r + (m.neutralSite ? 0 : 60)) - a.r) / 400));
  const res = hs > as ? 1 : hs === as ? 0.5 : 0;
  const gd = Math.abs(hs - as);
  const mult = gd <= 1 ? 1 : gd === 2 ? 1.3 : 1.5 + (gd - 3) * 0.1;
  const K = t => t.n < 10 ? 40 : 24;
  const dH = +(K(h) * mult * (res - exp)).toFixed(1);
  const dA = +(K(a) * mult * ((1 - res) - (1 - exp))).toFixed(1);
  h.r = +(h.r + dH).toFixed(1); h.d = dH;
  a.r = +(a.r + dA).toFixed(1); a.d = dA;

  h.atk ??= 1; h.def ??= 1; a.atk ??= 1; a.def ??= 1;
  const MU = 1.30;
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
  db.done[m.id] = 1; db.order.push(m.id);
  while (db.order.length > 4000) delete db.done[db.order.shift()];
  return true;
}

const from = new Date(); from.setDate(from.getDate() - 4);
const to = new Date();
const range = `${dayKey(from)}-${dayKey(to)}`;

const events = [];
for (const lg of LEAGUES) {
  try {
    const res = await fetch(`${API}/${lg}/scoreboard?dates=${range}&limit=400`);
    if (!res.ok) continue;
    const data = await res.json();
    for (const ev of (data.events || [])) {
      if (!isFinal(ev.status?.type)) continue;
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      events.push({
        id: ev.id, date: ev.date,
        neutralSite: !!comp.neutralSite || NEUTRAL.has(lg),
        home: { id: home.id, name: home.team?.displayName, logo: home.team?.logo, score: home.score },
        away: { id: away.id, name: away.team?.displayName, logo: away.team?.logo, score: away.score },
      });
    }
  } catch (e) { console.error(`${lg}: ${e.message}`); }
}

events.sort((x, y) => new Date(x.date) - new Date(y.date));
let n = 0;
for (const m of events) if (record(m)) n++;

mkdirSync(new URL('../docs/data/', import.meta.url), { recursive: true });
writeFileSync(DATA_PATH, JSON.stringify(db));
console.log(`processed ${n} new finished matches — ${Object.keys(db.teams).length} teams in db`);

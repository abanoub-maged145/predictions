// ============================================================
// محرك الثقة v2 — Confidence Engine
// الأعمدة: المواجهات المباشرة (وزن زمني + تطابق اللاعيبة)
//          الفورمة (بقوة الخصم + فورمة الأرض + الراحة)
//          اكتمال التشكيلة
//          رأي السوق (أسعار المراهنات كمُعاير خارجي)
// + مصفوفة بواسون كاملة + معايرة ذاتية من النتائج الفعلية
// ============================================================

const Engine = (() => {

  // ---------- أدوات رياضية ----------
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const fact = n => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
  const pois = (k, lam) => Math.exp(-lam) * Math.pow(lam, k) / fact(k);

  const DEFAULT_WEIGHTS = { h2h: 0.32, form: 0.46, squad: 0.22 };
  const HOME_ADV = 5.5;

  // ---------- تحويل أسعار المراهنات لاحتمالات ----------
  const amToProb = ml => {
    if (ml == null || isNaN(ml)) return null;
    return ml < 0 ? (-ml) / ((-ml) + 100) : 100 / (ml + 100);
  };

  // بيرجع احتمالات السوق بعد شيل هامش الشركة (de-vig)
  function parseMarketOdds(pickcenter) {
    for (const pc of (pickcenter || [])) {
      const rH = amToProb(pc.homeTeamOdds?.moneyLine);
      const rD = amToProb(pc.drawOdds?.moneyLine);
      const rA = amToProb(pc.awayTeamOdds?.moneyLine);
      if (rH == null || rD == null || rA == null) continue;
      const s = rH + rD + rA;
      const out = {
        provider: pc.provider?.name || 'السوق',
        pH: rH / s, pD: rD / s, pA: rA / s,
        ou: null,
      };
      const rO = amToProb(pc.overOdds), rU = amToProb(pc.underOdds);
      if (rO != null && rU != null && pc.overUnder != null) {
        const s2 = rO + rU;
        out.ou = { line: pc.overUnder, pOver: rO / s2, pUnder: rU / s2 };
      }
      return out;
    }
    return null;
  }

  // ---------- العمود الأول: المواجهات المباشرة ----------
  function h2hPillar(h2hGames, homeId, awayId, overlapByGame) {
    const now = Date.now();
    let wHome = 0, wAway = 0, wTotal = 0, used = 0;
    let goalsH = 0, goalsA = 0, wGoals = 0;
    const detail = [];

    for (const g of (h2hGames || [])) {
      const hs = parseInt(g.homeTeamScore, 10);
      const as = parseInt(g.awayTeamScore, 10);
      if (isNaN(hs) || isNaN(as)) continue;
      const t = new Date(g.gameDate).getTime();
      if (isNaN(t) || t > now) continue;

      const ageYears = (now - t) / (365.25 * 24 * 3600 * 1000);
      if (ageYears > 6) continue;

      let w = Math.exp(-ageYears / 2.2);
      const ov = overlapByGame && overlapByGame[g.id];
      if (typeof ov === 'number') w *= (0.35 + 0.65 * ov);

      let hGoals, aGoals;
      if (String(g.homeTeamId) === String(homeId)) { hGoals = hs; aGoals = as; }
      else if (String(g.awayTeamId) === String(homeId)) { hGoals = as; aGoals = hs; }
      else continue;

      if (hGoals > aGoals) wHome += w;
      else if (aGoals > hGoals) wAway += w;
      else { wHome += w * 0.5; wAway += w * 0.5; }

      goalsH += hGoals * w; goalsA += aGoals * w; wGoals += w;
      wTotal += w; used++;
      detail.push({ date: g.gameDate, score: `${hGoals}-${aGoals}`, weight: w, overlap: ov ?? null });
    }

    if (used === 0) return { available: false, games: 0, homeScore: 50, awayScore: 50, avgGoals: null, detail: [] };
    return {
      available: true, games: used,
      homeScore: Math.round((wHome / wTotal) * 100),
      awayScore: Math.round((wAway / wTotal) * 100),
      avgGoals: wGoals > 0 ? (goalsH + goalsA) / wGoals : null,
      detail,
    };
  }

  // ---------- العمود الثاني: الفورمة (قوة الخصم + الأرض + الراحة) ----------
  // oppStrength: خريطة teamId -> percentile من 0 لـ 1 (1 = فريق قمة)
  // strengthOf: دالة بديلة أذكى (ترتيب + Elo) — ليها الأولوية لو موجودة
  function formPillar(games, teamId, { oppStrength = {}, strengthOf = null, kickoff = null, venue = null } = {}) {
    const now = Date.now();
    const finished = (games || []).filter(g => {
      const hs = parseInt(g.homeTeamScore, 10), as = parseInt(g.awayTeamScore, 10);
      return !isNaN(hs) && !isNaN(as) && new Date(g.gameDate).getTime() < now;
    }).sort((a, b) => new Date(b.gameDate) - new Date(a.gameDate)).slice(0, 10);

    if (!finished.length) return { available: false, games: 0, score: 50, gfAvg: 1.3, gaAvg: 1.3, seq: [], rest: null, congestion: 0, venueScore: null, venueGames: 0 };

    const calc = subset => {
      let pts = 0, wT = 0, gf = 0, ga = 0;
      subset.forEach((g, i) => {
        const w = Math.pow(0.85, i);
        const hs = parseInt(g.homeTeamScore, 10), as = parseInt(g.awayTeamScore, 10);
        const wasHome = String(g.homeTeamId) === String(teamId);
        const myGoals = wasHome ? hs : as, oppGoals = wasHome ? as : hs;
        const oppId = wasHome ? g.awayTeamId : g.homeTeamId;
        const sf = (strengthOf ? strengthOf(oppId) : oppStrength[String(oppId)]) ?? 0.5; // قوة الخصم

        let p;
        if (myGoals > oppGoals) { p = (0.78 + 0.47 * sf) * (wasHome ? 1 : 1.1); } // فوز على قوي = نقاط أكتر
        else if (myGoals === oppGoals) { p = 0.45 * (0.7 + 0.6 * sf); }
        else { p = 0.08 * sf; } // الخسارة من قوي أهون شوية من الخسارة من ضعيف

        pts += clamp(p, 0, 1.35) * w; wT += w;
        gf += myGoals * w; ga += oppGoals * w;
      });
      return wT ? { score: clamp((pts / wT) * 100 / 1.1, 0, 100), gf: gf / wT, ga: ga / wT } : null;
    };

    const overall = calc(finished.slice(0, 8));
    const seq = finished.slice(0, 8).map(g => {
      const hs = parseInt(g.homeTeamScore, 10), as = parseInt(g.awayTeamScore, 10);
      const wasHome = String(g.homeTeamId) === String(teamId);
      const my = wasHome ? hs : as, op = wasHome ? as : hs;
      return my > op ? 'W' : my === op ? 'D' : 'L';
    });

    // فورمة الملعب: صاحب الأرض في أرضه / الضيف برة
    let venueScore = null, venueGames = 0;
    if (venue) {
      const vGames = finished.filter(g => (String(g.homeTeamId) === String(teamId)) === (venue === 'home')).slice(0, 6);
      venueGames = vGames.length;
      if (vGames.length >= 3) venueScore = calc(vGames)?.score ?? null;
    }
    let score = overall.score;
    if (venueScore != null) score = 0.62 * overall.score + 0.38 * venueScore;

    // الراحة وضغط الجدول
    let rest = null, congestion = 0;
    const ref = kickoff ? new Date(kickoff).getTime() : now;
    const last = new Date(finished[0].gameDate).getTime();
    rest = Math.max(0, Math.round((ref - last) / (24 * 3600 * 1000)));
    congestion = finished.filter(g => ref - new Date(g.gameDate).getTime() < 15 * 24 * 3600 * 1000).length;

    return {
      available: true, games: finished.length,
      score: Math.round(clamp(score, 0, 100)),
      gfAvg: overall.gf, gaAvg: overall.ga,
      seq, rest, congestion,
      venueScore: venueScore != null ? Math.round(venueScore) : null, venueGames,
    };
  }

  // تعديل القوة حسب الراحة: راحة قليلة أو جدول مضغوط = خصم
  function restAdjust(form) {
    if (!form.available || form.rest == null) return 0;
    let adj = clamp((Math.min(form.rest, 10) - 4.5) * 0.85, -4, 2.5);
    if (form.congestion >= 5) adj -= 2;
    return adj;
  }

  // ---------- العمود الثالث: اكتمال التشكيلة ----------
  function squadPillar(roster, injuries) {
    const injuryCount = (injuries || []).length;
    if (!roster || !roster.length) {
      return { available: false, score: clamp(72 - injuryCount * 7, 40, 85), injuries: injuryCount, starters: 0 };
    }
    const starters = roster.filter(p => p.starter).length;
    let score = starters >= 11 ? 100 : 80;
    score -= injuryCount * 7;
    return { available: true, score: clamp(score, 40, 100), injuries: injuryCount, starters };
  }

  // ---------- مصفوفة بواسون الكاملة (بتصحيح Dixon-Coles) ----------
  // بواسون المستقلة بتقلل من احتمال النتايج الواطية (0-0 و1-1) —
  // التصحيح بيعدل الخانات الأربع دول زي ما أثبتته بيانات عشرات المواسم
  const DC_RHO = -0.09;
  function poissonMatrix(lh, la, max = 7) {
    const ph = [], pa = [];
    let sh = 0, sa = 0;
    for (let k = 0; k < max; k++) { ph.push(pois(k, lh)); sh += ph[k]; pa.push(pois(k, la)); sa += pa[k]; }
    ph.push(Math.max(0, 1 - sh)); pa.push(Math.max(0, 1 - sa)); // الذيل

    const tau = (h, a) =>
      h === 0 && a === 0 ? 1 - lh * la * DC_RHO :
      h === 0 && a === 1 ? 1 + lh * DC_RHO :
      h === 1 && a === 0 ? 1 + la * DC_RHO :
      h === 1 && a === 1 ? 1 - DC_RHO : 1;

    let pHW = 0, pD = 0, pAW = 0, pO15 = 0, pO25 = 0, pO35 = 0, pBtts = 0, T = 0;
    const scores = [];
    for (let h = 0; h <= max; h++) {
      for (let a = 0; a <= max; a++) {
        const p = ph[h] * pa[a] * tau(h, a);
        T += p;
        if (h > a) pHW += p; else if (h === a) pD += p; else pAW += p;
        const tot = h + a;
        if (tot > 1.5) pO15 += p;
        if (tot > 2.5) pO25 += p;
        if (tot > 3.5) pO35 += p;
        if (h > 0 && a > 0) pBtts += p;
        if (h < max && a < max) scores.push({ h, a, p });
      }
    }
    // إعادة تطبيع بعد التصحيح عشان المجموع يرجع 100%
    pHW /= T; pD /= T; pAW /= T; pO15 /= T; pO25 /= T; pO35 /= T; pBtts /= T;
    for (const s of scores) s.p /= T;
    scores.sort((x, y) => y.p - x.p);
    return { pHW, pD, pAW, pO15, pO25, pO35, pBtts, topScores: scores.slice(0, 3) };
  }

  // ---------- المعايرة الذاتية ----------
  // calib: { _all: {'60': factor, ...}, byMkt: { '1X2': {...}, 'OU25': {...} } }
  // معايرة كل سوق لوحده أدق (انحياز خط الأهداف غير انحياز النتيجة) —
  // ولو عينة السوق قليلة بنرجع للمعايرة العامة. بندعم الشكل القديم المسطح برضه.
  const bucketOf = c => c >= 90 ? '90' : c >= 80 ? '80' : c >= 70 ? '70' : c >= 60 ? '60' : '50';
  function calibrate(rawConf, calib, mkt) {
    if (!calib) return rawConf;
    const b = bucketOf(rawConf);
    const flat = calib._all || calib.byMkt ? calib._all : calib;
    const f = (mkt && calib.byMkt?.[mkt]?.[b]) ?? flat?.[b];
    if (!f) return rawConf;
    return Math.round(clamp(rawConf * f, 5, 96));
  }

  // ---------- التحليل الرئيسي ----------
  function analyze({
    h2hGames, homeForm, awayForm, homeId, awayId,
    homeRoster, awayRoster, homeInjuries, awayInjuries,
    overlapByGame, neutralSite, kickoff,
    oppStrength = {}, strengthOf = null, pickcenter = null,
    elo = null, adRates = null, marketWeight = 0.45,
    learnedWeights = null, calib = null,
    homeName = 'صاحب الأرض', awayName = 'الضيف',
  }) {
    const h2h = h2hPillar(h2hGames, homeId, awayId, overlapByGame);
    const fH = formPillar(homeForm, homeId, { oppStrength, strengthOf, kickoff, venue: neutralSite ? null : 'home' });
    const fA = formPillar(awayForm, awayId, { oppStrength, strengthOf, kickoff, venue: neutralSite ? null : 'away' });
    const sH = squadPillar(homeRoster, homeInjuries);
    const sA = squadPillar(awayRoster, awayInjuries);
    const market = parseMarketOdds(pickcenter);

    // الأوزان: المتعلمة لو موجودة، وإلا الافتراضية — مع إعادة توزيع لو مفيش مواجهات
    const base = learnedWeights || DEFAULT_WEIGHTS;
    let w = { ...base };
    if (!h2h.available) {
      w = { h2h: 0, form: base.form + base.h2h * 0.7, squad: base.squad + base.h2h * 0.3 };
    } else if (h2h.games < 3) {
      const shift = base.h2h * 0.4;
      w = { h2h: base.h2h - shift, form: base.form + shift * 0.7, squad: base.squad + shift * 0.3 };
    }

    const restH = restAdjust(fH), restA = restAdjust(fA);
    const strengthHome = w.h2h * h2h.homeScore + w.form * fH.score + w.squad * sH.score + (neutralSite ? 0 : HOME_ADV) + restH;
    const strengthAway = w.h2h * h2h.awayScore + w.form * fA.score + w.squad * sA.score + restA;
    const diff = strengthHome - strengthAway;

    // 1X2 من نموذج القوة
    const pH0 = 1 / (1 + Math.pow(10, -diff / 26));
    const pDrawS = clamp(0.30 * Math.exp(-Math.abs(diff) / 28), 0.12, 0.32);
    let pHome = pH0 * (1 - pDrawS);
    let pAway = (1 - pH0) * (1 - pDrawS);
    let pDraw = pDrawS;

    // الأهداف المتوقعة
    let lamH = 0.58 * fH.gfAvg + 0.42 * fA.gaAvg;
    let lamA = 0.58 * fA.gfAvg + 0.42 * fH.gaAvg;
    if (h2h.available && h2h.avgGoals != null) {
      const scale = clamp(h2h.avgGoals / Math.max(lamH + lamA, 0.5), 0.75, 1.25);
      lamH *= Math.pow(scale, 0.5); lamA *= Math.pow(scale, 0.5);
    }
    if (!neutralSite) { lamH *= 1.06; lamA *= 0.96; }

    // تقييمات الهجوم/الدفاع المتراكمة — أدق من متوسطات آخر 8 ماتشات لأنها
    // مبنية على كل تاريخ الفريق موزوناً بقوة الخصوم. وزنها بيزيد مع حجم العينة
    if (adRates?.home?.atk && adRates?.away?.atk) {
      const rel = Math.min(adRates.home.n || 0, adRates.away.n || 0);
      if (rel >= 5) {
        const gH = clamp(adRates.home.atk * adRates.away.def * 1.30 * (neutralSite ? 1 : 1.12), 0.2, 4);
        const gA = clamp(adRates.away.atk * adRates.home.def * 1.30 * (neutralSite ? 1 : 0.94), 0.2, 4);
        const wAD = 0.5 * rel / (rel + 8);
        lamH = (1 - wAD) * lamH + wAD * gH;
        lamA = (1 - wAD) * lamA + wAD * gA;
      }
    }
    lamH = clamp(lamH, 0.25, 3.6); lamA = clamp(lamA, 0.25, 3.6);

    const mx = poissonMatrix(lamH, lamA);

    // دمج نموذج القوة مع مصفوفة بواسون
    pHome = 0.62 * pHome + 0.38 * mx.pHW;
    pDraw = 0.62 * pDraw + 0.38 * mx.pD;
    pAway = 0.62 * pAway + 0.38 * mx.pAW;

    // دمج تقييم Elo — مقياس قوة موحد بيتبني من كل النتايج، وبيحل مشكلة
    // مقارنة فرق من دوريات مختلفة. وزنه بيزيد كل ما عدد ماتشات الفريقين المتسجلة يزيد
    let eloInfo = null;
    if (elo?.home && elo?.away) {
      const rel = Math.min(elo.home.n || 0, elo.away.n || 0);
      eloInfo = { home: Math.round(elo.home.r), away: Math.round(elo.away.r), games: rel, weight: 0 };
      if (rel >= 4) {
        const dElo = elo.home.r - elo.away.r + (neutralSite ? 0 : 60);
        const pE = 1 / (1 + Math.pow(10, -dElo / 400));
        const pDrawE = clamp(0.30 * Math.exp(-Math.abs(dElo) / 220), 0.14, 0.30);
        const wE = 0.35 * rel / (rel + 10);
        pHome = (1 - wE) * pHome + wE * pE * (1 - pDrawE);
        pAway = (1 - wE) * pAway + wE * (1 - pE) * (1 - pDrawE);
        pDraw = (1 - wE) * pDraw + wE * pDrawE;
        eloInfo.weight = wE;
      }
    }

    // دمج رأي السوق (العمود الرابع) — وزنه بيتعلم من النتايج:
    // لو السوق بيكسب نموذجنا في الخلافات وزنه بيزيد، والعكس صحيح
    let marketAgreement = null, modelPick = null, marketPick = null;
    const mw = clamp(marketWeight, 0.30, 0.60);
    if (market) {
      modelPick = pHome >= pAway && pHome >= pDraw ? 'H' : pAway >= pDraw ? 'A' : 'D';
      marketPick = market.pH >= market.pA && market.pH >= market.pD ? 'H' : market.pA >= market.pD ? 'A' : 'D';
      marketAgreement = modelPick === marketPick;
      pHome = (1 - mw) * pHome + mw * market.pH;
      pDraw = (1 - mw) * pDraw + mw * market.pD;
      pAway = (1 - mw) * pAway + mw * market.pA;
    }
    const sum1x2 = pHome + pDraw + pAway;
    pHome /= sum1x2; pDraw /= sum1x2; pAway /= sum1x2;

    let pOver25 = mx.pO25, pUnder25 = 1 - mx.pO25;
    if (market?.ou && Math.abs(market.ou.line - 2.5) < 0.01) {
      pOver25 = 0.58 * pOver25 + 0.42 * market.ou.pOver;
      pUnder25 = 1 - pOver25;
    }
    const pBTTS = mx.pBtts;

    // جودة البيانات
    let quality = 0.32;
    if (h2h.available) quality += Math.min(h2h.games, 5) * 0.04;
    quality += Math.min(fH.games, 6) * 0.025 + Math.min(fA.games, 6) * 0.025;
    if (sH.available && sA.available) quality += 0.08;
    if (overlapByGame && Object.keys(overlapByGame).length) quality += 0.05;
    if (market) quality += 0.11;
    if (Object.keys(oppStrength).length || strengthOf) quality += 0.04;
    if (eloInfo?.weight) quality += 0.04;
    quality = clamp(quality, 0.3, 1);

    const confOf = (p, mkt, agreeBonus = 0) => calibrate(Math.round(clamp((0.72 * p + 0.28 * quality) * 100 + agreeBonus, 5, 96)), calib, mkt);

    // مكافأة/خصم اتفاق السوق على أسواق النتيجة
    const agreeAdj = marketAgreement === true ? 3 : marketAgreement === false ? -5 : 0;

    // كشف فرص القيمة: نظامنا أعلى من السوق بفارق واضح
    const valueOf = (ourP, mktP) => (mktP != null && ourP - mktP >= 0.07) ? Math.round((ourP - mktP) * 100) : null;

    const markets = [];

    // فرصة مزدوجة
    const dcOpts = [
      { code: '1X', label: `فوز أو تعادل ${homeName}`, p: pHome + pDraw, mkt: market ? market.pH + market.pD : null },
      { code: 'X2', label: `فوز أو تعادل ${awayName}`, p: pAway + pDraw, mkt: market ? market.pA + market.pD : null },
      { code: '12', label: 'لا تعادل (أي فريق يكسب)', p: pHome + pAway, mkt: market ? market.pH + market.pA : null },
    ].sort((a, b) => b.p - a.p);
    markets.push({ market: 'DC', marketLabel: 'فرصة مزدوجة', pick: dcOpts[0].code, pickLabel: dcOpts[0].label, prob: dcOpts[0].p, mkt: dcOpts[0].mkt, conf: confOf(dcOpts[0].p, 'DC', agreeAdj), value: valueOf(dcOpts[0].p, dcOpts[0].mkt) });

    // خطوط الأهداف
    const ouMain = pOver25 >= 0.5
      ? { code: 'O', label: 'أكثر من 2.5 هدف', p: pOver25, mkt: market?.ou && Math.abs(market.ou.line - 2.5) < 0.01 ? market.ou.pOver : null }
      : { code: 'U', label: 'أقل من 2.5 هدف', p: pUnder25, mkt: market?.ou && Math.abs(market.ou.line - 2.5) < 0.01 ? market.ou.pUnder : null };
    markets.push({ market: 'OU25', marketLabel: 'خط 2.5 هدف', pick: ouMain.code, pickLabel: ouMain.label, prob: ouMain.p, mkt: ouMain.mkt, conf: confOf(ouMain.p, 'OU25'), value: valueOf(ouMain.p, ouMain.mkt) });

    if (mx.pO15 >= 0.78) markets.push({ market: 'OU15', marketLabel: 'خط 1.5 هدف', pick: 'O', pickLabel: 'أكثر من 1.5 هدف', prob: mx.pO15, conf: confOf(mx.pO15, 'OU15'), value: null });
    if ((1 - mx.pO35) >= 0.78) markets.push({ market: 'OU35', marketLabel: 'خط 3.5 هدف', pick: 'U', pickLabel: 'أقل من 3.5 هدف', prob: 1 - mx.pO35, conf: confOf(1 - mx.pO35, 'OU35'), value: null });

    // تسجيل الفريقين
    const bttsPick = pBTTS >= 0.5
      ? { code: 'Y', label: 'الفريقين يسجلوا', p: pBTTS }
      : { code: 'N', label: 'مش هيسجلوا مع بعض', p: 1 - pBTTS };
    markets.push({ market: 'BTTS', marketLabel: 'تسجيل الفريقين', pick: bttsPick.code, pickLabel: bttsPick.label, prob: bttsPick.p, conf: confOf(bttsPick.p, 'BTTS'), value: null });

    // نتيجة الماتش
    const oneXtwo = [
      { code: 'H', label: `فوز ${homeName}`, p: pHome, mkt: market?.pH },
      { code: 'D', label: 'تعادل', p: pDraw, mkt: market?.pD },
      { code: 'A', label: `فوز ${awayName}`, p: pAway, mkt: market?.pA },
    ].sort((a, b) => b.p - a.p);
    markets.push({ market: '1X2', marketLabel: 'نتيجة الماتش', pick: oneXtwo[0].code, pickLabel: oneXtwo[0].label, prob: oneXtwo[0].p, mkt: oneXtwo[0].mkt ?? null, conf: confOf(oneXtwo[0].p, '1X2', agreeAdj), value: valueOf(oneXtwo[0].p, oneXtwo[0].mkt) });

    // النتيجة بالظبط (احتمالها صغير بطبيعتها — للاستئناس والجرأة)
    const ts = mx.topScores[0];
    if (ts) markets.push({ market: 'CS', marketLabel: 'النتيجة بالظبط', pick: `${ts.h}-${ts.a}`, pickLabel: `النتيجة ${ts.h} - ${ts.a}`, prob: ts.p, conf: confOf(ts.p, 'CS'), value: null });

    markets.sort((a, b) => b.conf - a.conf);

    // ميول الأعمدة (للتعلم الذاتي: أنهي عمود بيصيب أكتر؟)
    const leanOf = (h, a) => h - a > 4 ? 'H' : a - h > 4 ? 'A' : 'D';
    const pillarLeans = {
      h2h: h2h.available ? leanOf(h2h.homeScore, h2h.awayScore) : null,
      form: leanOf(fH.score, fA.score),
      squad: (sH.available || sA.available) ? leanOf(sH.score, sA.score) : null,
    };

    return {
      pillars: { h2h, form: { home: fH, away: fA }, squad: { home: sH, away: sA } },
      market, marketAgreement, modelPick, marketPick, marketWeightUsed: mw,
      eloInfo,
      weightsUsed: w,
      strength: { home: Math.round(strengthHome), away: Math.round(strengthAway) },
      rest: { home: fH.rest, away: fA.rest, adjHome: restH, adjAway: restA },
      probs: { home: pHome, draw: pDraw, away: pAway, over25: pOver25, btts: pBTTS },
      expGoals: { home: lamH, away: lamA },
      topScores: mx.topScores,
      quality, markets, best: markets[0],
      pillarLeans,
    };
  }

  // ---------- تقييم توقع بعد النتيجة ----------
  function evaluatePick(item, homeScore, awayScore) {
    const total = homeScore + awayScore;
    switch (item.market) {
      case '1X2':
        if (item.pickCode === 'H') return homeScore > awayScore;
        if (item.pickCode === 'A') return awayScore > homeScore;
        return homeScore === awayScore;
      case 'DC':
        if (item.pickCode === '1X') return homeScore >= awayScore;
        if (item.pickCode === 'X2') return awayScore >= homeScore;
        return homeScore !== awayScore;
      case 'OU15': return item.pickCode === 'O' ? total > 1.5 : total < 1.5;
      case 'OU25': return item.pickCode === 'O' ? total > 2.5 : total < 2.5;
      case 'OU35': return item.pickCode === 'O' ? total > 3.5 : total < 3.5;
      case 'BTTS':
        return item.pickCode === 'Y' ? (homeScore > 0 && awayScore > 0) : (homeScore === 0 || awayScore === 0);
      case 'CS': return item.pickCode === `${homeScore}-${awayScore}`;
    }
    return null;
  }

  return { analyze, evaluatePick, bucketOf, DEFAULT_WEIGHTS };
})();

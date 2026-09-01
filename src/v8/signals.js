import { round } from "./config.js";

const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(avg(a.map(x => (x - m) ** 2))); };
const ema = (a, p) => { if (!a.length) return 0; const k = 2 / (p + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; };
const rsi = (a, p = 14) => { if (a.length <= p) return 50; let g = 0, l = 0; for (let i = a.length - p; i < a.length; i++) { const d = a[i] - a[i - 1]; d >= 0 ? g += d : l -= d; } if (!l) return 100; const r = g / l; return 100 - 100 / (1 + r); };
const atr = (b, p = 14) => { if (!b || b.length < p + 1) return 0; const t = []; for (let i = b.length - p; i < b.length; i++) { const h = +b[i].h, l = +b[i].l, pc = +b[i - 1].c; t.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); } return avg(t); };
const INVERSE = new Set(["SH", "PSQ", "RWM", "SQQQ", "SPXU", "SOXS", "TZA"]);

export function timeframeSignal(symbol, bars) {
  const b = (bars || []).filter(x => [x.c, x.h, x.l, x.v].every(v => Number.isFinite(+v)));
  if (b.length < 35) return { symbol, valid: false };
  const c = b.map(x => +x.c), h = b.map(x => +x.h), l = b.map(x => +x.l), v = b.map(x => +x.v);
  const price = c.at(-1), e9 = ema(c.slice(-45), 9), e21 = ema(c.slice(-60), 21), p9 = ema(c.slice(-46, -1), 9), p21 = ema(c.slice(-61, -1), 21);
  const r = rsi(c), a = atr(b), ap = price ? a / price : 0, av = avg(v.slice(-21, -1)), rv = av ? v.at(-1) / av : 0;
  const hi = Math.max(...h.slice(-21, -1)), lo = Math.min(...l.slice(-21, -1));
  const r1 = c.length > 1 ? price / c.at(-2) - 1 : 0, r3 = c.length > 3 ? price / c.at(-4) - 1 : 0, r6 = c.length > 6 ? price / c.at(-7) - 1 : 0;
  const rets = c.slice(-21).slice(1).map((x, i) => x / c.slice(-21)[i] - 1), vol = sd(rets);
  let pv = 0, vs = 0;
  for (const x of b) { const tp = (+x.h + +x.l + +x.c) / 3; pv += tp * (+x.v); vs += +x.v; }
  const vw = vs ? pv / vs : price, tr = e9 > e21, dn = e9 < e21, up = e9 > p9 && e21 >= p21, ds = e9 < p9 && e21 <= p21;
  const ab = price > vw, bl = price < vw, bo = price > hi * 1.0002 && c.at(-2) <= hi * 1.001, bd = price < lo * 0.9998 && c.at(-2) >= lo * 0.999;
  const pb = tr && up && ab && price >= e9 * 0.9985 && price <= e9 * 1.0025, spb = dn && ds && bl && price <= e9 * 1.0015 && price >= e9 * 0.9975;
  const m = r3 > 0.001 && r6 > 0.0018, dm = r3 < -0.001 && r6 < -0.0018, gap = Math.abs(e9 / e21 - 1), ch = gap < 0.0009 || (Math.abs(r6) < 0.0015 && vol < 0.0012);
  return { symbol, valid: true, price, ema9: e9, ema21: e21, vwap: vw, rsi14: r, atrPct: ap, relVolume: rv, ret1: r1, ret3: r3, ret6: r6, volatility: vol, trend: tr, downTrend: dn, trendSlope: up, downSlope: ds, aboveVwap: ab, belowVwap: bl, breakout: bo, breakdown: bd, pullback: pb, shortPullback: spb, momentum: m, downsideMomentum: dm, choppy: ch };
}

export function combineSignals(symbol, s1, s5, s15, snap) {
  if (!s1?.valid || !s5?.valid || !s15?.valid) return { symbol, valid: false };
  const q = snap?.latestQuote || snap?.latest_quote || {}, t = snap?.latestTrade || snap?.latest_trade || {}, d = snap?.dailyBar || snap?.daily_bar || {};
  const bid = +(q.bp || q.bid_price || 0), ask = +(q.ap || q.ask_price || 0), bidSize = +(q.bs || q.bid_size || 0), askSize = +(q.as || q.ask_size || 0);
  const last = +(t.p || t.price || s1.price || s5.price), mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last, spread = mid > 0 && ask >= bid ? (ask - bid) / mid : 1;
  const dollarVolume = (+d.v || 0) * last, qt = Date.parse(q.t || q.timestamp || 0), tt = Date.parse(t.t || t.timestamp || 0), now = Date.now();
  const qa = Number.isFinite(qt) ? (now - qt) / 1000 : 9999, ta = Number.isFinite(tt) ? (now - tt) / 1000 : 9999;
  const halted = Boolean(snap?.realtimeHalted), luld = snap?.realtimeLuld || null, limitUp = +(luld?.u || 0), limitDown = +(luld?.d || 0);
  const nearLuld = Boolean((limitUp > 0 && last >= limitUp * 0.995) || (limitDown > 0 && last <= limitDown * 1.005));

  const la = s1.trend && s5.trend && s15.trend && s5.trendSlope && s15.trendSlope && s5.aboveVwap;
  const sa = s1.downTrend && s5.downTrend && s15.downTrend && s5.downSlope && s15.downSlope && s5.belowVwap;
  const sv = s5.atrPct >= 0.0005 && s5.atrPct <= 0.04;
  const ne = last <= Math.max(s5.vwap, s5.ema9) * 1.02;
  const nes = last >= Math.min(s5.vwap, s5.ema9) * 0.98;
  const rawChop = s1.choppy && s5.choppy;

  const positiveFlow = s1.ret1 > 0 || s1.ret3 > 0 || s5.ret1 > 0 || s5.ret3 > 0 || s15.ret1 > 0;
  const trendSupport = la || s5.trend || s15.trend || s5.trendSlope || s15.trendSlope || s5.aboveVwap;
  const longPotential = !halted && !nearLuld && sv && ne && positiveFlow && trendSupport && s5.rsi14 < 88;
  const effectiveChop = rawChop && !longPotential;

  const volumeBoost = Math.min(15, Math.max(0, (s5.relVolume - 0.5) * 6));
  const longVelocity = s1.ret3 > 0 && s5.ret3 > 0 && s15.ret3 > 0 ? 12 : (s1.ret3 > 0 && s5.ret3 > 0 ? 7 : positiveFlow ? 3 : 0);
  const shortVelocity = s1.ret3 < 0 && s5.ret3 < 0 && s15.ret3 < 0 ? 12 : (s1.ret3 < 0 && s5.ret3 < 0 ? 7 : 0);
  const longAcceleration = s1.ret1 > 0 && s1.ret3 > 0 ? 6 : 0;
  const shortAcceleration = s1.ret1 < 0 && s1.ret3 < 0 ? 6 : 0;
  const longChasePenalty = s1.ret3 > 0.03 || s5.ret3 > 0.05 ? 18 : s1.ret1 > 0.02 ? 8 : 0;
  const shortChasePenalty = s1.ret3 < -0.03 || s5.ret3 < -0.05 ? 18 : s1.ret1 < -0.02 ? 8 : 0;

  let score = 0, ss = 0;
  if (la) score += 30; else if (trendSupport) score += 16;
  if (s5.pullback) score += 18;
  if (s5.breakout && s5.momentum) score += 20;
  if (s15.trendSlope) score += 10;
  if (s5.rsi14 >= 45 && s5.rsi14 <= 80) score += 8;
  if (s5.relVolume >= 0.5) score += 8;
  if (sv) score += 7;
  if (!effectiveChop) score += 8;
  if (spread <= 0.0025) score += 8;
  if (longPotential) score += 12;
  score += volumeBoost + longVelocity + longAcceleration - longChasePenalty;
  if (spread > 0.01) score -= 40;
  if (qa > 60) score -= 40;
  if (effectiveChop) score -= 15;
  if (halted || nearLuld) score -= 100;

  if (sa) ss += 30;
  if (s5.shortPullback) ss += 18;
  if (s5.breakdown && s5.downsideMomentum) ss += 20;
  if (s15.downSlope) ss += 10;
  if (s5.rsi14 >= 20 && s5.rsi14 <= 55) ss += 8;
  if (s5.relVolume >= 0.5) ss += 8;
  if (sv) ss += 7;
  if (!effectiveChop) ss += 8;
  if (spread <= 0.0025) ss += 8;
  ss += volumeBoost + shortVelocity + shortAcceleration - shortChasePenalty;
  if (spread > 0.01) ss -= 40;
  if (qa > 60) ss -= 40;
  if (effectiveChop) ss -= 15;
  if (halted || nearLuld) ss -= 100;

  return {
    symbol, valid: true, price: last, bid, ask, bidSize, askSize, dollarVolume, mid, spreadPct: spread, quoteAgeSec: qa, tradeAgeSec: ta,
    halted, nearLuld, limitUp, limitDown, atrPct: s5.atrPct, rvol: s5.relVolume, rsi: s5.rsi14,
    longAligned: la, shortAligned: sa, longContinuation: longPotential,
    longConfirmed: longPotential,
    shortConfirmed: !halted && !nearLuld && sa && sv && nes && (s5.shortPullback || s5.breakdown || s5.downsideMomentum),
    score, shortScore: ss, chop: effectiveChop, s1, s5, s15
  };
}

export function marketRegime(map) {
  const entries = [...map.entries()], vals = entries.filter(([symbol]) => !INVERSE.has(symbol)).map(([, signal]) => signal);
  const r = ["SPY", "QQQ", "IWM"].map(s => map.get(s)).filter(Boolean);
  if (!r.length) return { mode: "unknown", longOk: true, shortOk: false, breadth: 0, shock: false };
  const l = r.filter(s => s.longAligned).length, sh = r.filter(s => s.shortAligned).length;
  const b = vals.filter(s => s.valid).reduce((a, s) => a + (s.longAligned ? 1 : s.shortAligned ? -1 : 0), 0) / Math.max(1, vals.length);
  const shock = r.some(s => Math.abs(s.s1.ret1) > 0.012 || s.spreadPct > 0.015 || s.halted || s.nearLuld);
  const mode = shock ? "shock" : l >= 2 && b > 0.1 ? "bull" : sh >= 2 && b < -0.1 ? "bear" : "sideways";
  return { mode, longOk: !shock, shortOk: mode === "bear" && !shock, breadth: round(b, 3), shock };
}

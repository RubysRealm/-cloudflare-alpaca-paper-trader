import { round } from "./config.js";

const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(avg(a.map(x => (x - m) ** 2))); };
const ema = (a, p) => { if (!a.length) return 0; const k = 2 / (p + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; };
const rsi = (a, p = 14) => { if (a.length <= p) return 50; let g = 0, l = 0; for (let i = a.length - p; i < a.length; i++) { const d = a[i] - a[i - 1]; d >= 0 ? g += d : l -= d; } if (!l) return 100; const r = g / l; return 100 - 100 / (1 + r); };
const atr = (b, p = 14) => { if (!b || b.length < p + 1) return 0; const t = []; for (let i = b.length - p; i < b.length; i++) { const h = +b[i].h, l = +b[i].l, pc = +b[i - 1].c; t.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); } return avg(t); };
const INVERSE = new Set(["SH","PSQ","RWM","SQQQ","SPXU","SOXS","TZA"]);

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
  const pb = tr && up && ab && price >= e9 * 0.998 && price <= e9 * 1.0035, spb = dn && ds && bl && price <= e9 * 1.002 && price >= e9 * 0.9965;
  const m = r3 > 0.0008 && r6 > 0.0014, dm = r3 < -0.0008 && r6 < -0.0014, gap = Math.abs(e9 / e21 - 1), ch = gap < 0.0008 || (Math.abs(r6) < 0.0012 && vol < 0.0011);
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
  const trendVotes = [s1.trend,s5.trend,s15.trend,s5.trendSlope,s15.trendSlope,s5.aboveVwap].filter(Boolean).length;
  const shortVotes = [s1.downTrend,s5.downTrend,s15.downTrend,s5.downSlope,s15.downSlope,s5.belowVwap].filter(Boolean).length;
  const positiveFlow = (s1.ret1 > 0 && s1.ret3 > 0) || (s5.ret1 > 0 && s5.ret3 > 0) || (s5.ret3 > 0 && s15.ret3 > 0);
  const negativeFlow = (s1.ret1 < 0 && s1.ret3 < 0) || (s5.ret1 < 0 && s5.ret3 < 0) || (s5.ret3 < 0 && s15.ret3 < 0);
  const volOk = s5.atrPct >= 0.0006 && s5.atrPct <= 0.035;
  const rsiOk = s5.rsi14 >= 44 && s5.rsi14 <= 78;
  const shortRsiOk = s5.rsi14 >= 22 && s5.rsi14 <= 56;
  const nearEntry = last <= Math.max(s5.vwap, s5.ema9) * 1.012;
  const nearShort = last >= Math.min(s5.vwap, s5.ema9) * 0.988;
  const chop = s1.choppy && s5.choppy;
  const continuation = (s5.pullback || s5.breakout || s5.momentum || (trendVotes >= 5 && positiveFlow));
  const shortContinuation = (s5.shortPullback || s5.breakdown || s5.downsideMomentum || (shortVotes >= 5 && negativeFlow));
  const longConfirmed = !halted && !nearLuld && !chop && volOk && rsiOk && nearEntry && trendVotes >= 4 && positiveFlow && continuation;
  const shortConfirmed = !halted && !nearLuld && !chop && volOk && shortRsiOk && nearShort && shortVotes >= 4 && negativeFlow && shortContinuation;

  const volumeBoost = Math.min(12, Math.max(-4, (s5.relVolume - 0.8) * 6));
  const spreadBoost = spread <= 0.0008 ? 10 : spread <= 0.0015 ? 7 : spread <= 0.003 ? 3 : -12;
  const velocity = Math.max(-12, Math.min(16, (s1.ret3 * 900) + (s5.ret3 * 500) + (s15.ret3 * 250)));
  const acceleration = s1.ret1 > 0 && s1.ret3 > 0 && s5.ret1 > 0 ? 7 : 0;
  const chasePenalty = s1.ret3 > 0.02 || s5.ret3 > 0.035 ? 18 : s1.ret1 > 0.012 ? 9 : 0;
  let score = trendVotes * 8 + (la ? 16 : 0) + (s5.pullback ? 14 : 0) + (s5.breakout && s5.momentum ? 17 : 0) + (rsiOk ? 7 : -8) + (volOk ? 7 : -10) + (longConfirmed ? 14 : 0) + volumeBoost + spreadBoost + velocity + acceleration - chasePenalty;
  if (qa > 20) score -= 25;
  if (chop) score -= 18;
  if (halted || nearLuld) score -= 100;

  const shortVelocity = Math.max(-12, Math.min(16, (-s1.ret3 * 900) + (-s5.ret3 * 500) + (-s15.ret3 * 250)));
  let shortScore = shortVotes * 8 + (sa ? 16 : 0) + (s5.shortPullback ? 14 : 0) + (s5.breakdown && s5.downsideMomentum ? 17 : 0) + (shortRsiOk ? 7 : -8) + (volOk ? 7 : -10) + (shortConfirmed ? 14 : 0) + volumeBoost + spreadBoost + shortVelocity;
  if (qa > 20) shortScore -= 25;
  if (chop) shortScore -= 18;
  if (halted || nearLuld) shortScore -= 100;

  return { symbol, valid: true, price: last, bid, ask, bidSize, askSize, dollarVolume, mid, spreadPct: spread, quoteAgeSec: qa, tradeAgeSec: ta, halted, nearLuld, limitUp, limitDown, atrPct: s5.atrPct, rvol: s5.relVolume, rsi: s5.rsi14, longAligned: la, shortAligned: sa, trendVotes, shortVotes, longContinuation: continuation, longConfirmed, shortConfirmed, inverse: INVERSE.has(symbol), score, shortScore, chop, s1, s5, s15 };
}

export function marketRegime(map) {
  const entries = [...map.entries()], vals = entries.filter(([symbol]) => !INVERSE.has(symbol)).map(([, signal]) => signal);
  const r = ["SPY", "QQQ", "IWM"].map(s => map.get(s)).filter(Boolean);
  if (!r.length) return { mode: "unknown", longOk: true, shortOk: false, breadth: 0, shock: false };
  const l = r.filter(s => s.longAligned).length, sh = r.filter(s => s.shortAligned).length;
  const b = vals.filter(s => s.valid).reduce((a, s) => a + (s.longAligned ? 1 : s.shortAligned ? -1 : 0), 0) / Math.max(1, vals.length);
  const shock = r.some(s => Math.abs(s.s1.ret1) > 0.009 || s.spreadPct > 0.006 || s.halted || s.nearLuld);
  const mode = shock ? "shock" : l >= 2 && b > 0.08 ? "bull" : sh >= 2 && b < -0.08 ? "bear" : "sideways";
  return { mode, longOk: !shock, shortOk: mode === "bear" && !shock, breadth: round(b, 3), shock };
}
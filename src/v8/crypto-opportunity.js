import { alpaca, marketDataRaw } from "./api.js";
import { timeframeSignal, combineSignals } from "./signals.js";
import { num, pct, int, clamp, round } from "./config.js";

const PREFIX = "papercrypto-";
const norm = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const isBotOrder = o => String(o?.client_order_id || "").startsWith(PREFIX);
const enabled = env => String(env.CRYPTO_TRADING_ENABLED ?? "true").toLowerCase() === "true";

async function universe(env) {
  const assets = await alpaca(env, "/v2/assets?status=active&asset_class=crypto");
  return (Array.isArray(assets) ? assets : []).filter(a => {
    const s = String(a.symbol || "").toUpperCase();
    return a.status !== "inactive" && a.tradable !== false && a.fractionable !== false && (s.endsWith("/USD") || (!s.includes("/") && s.endsWith("USD")));
  }).slice(0, int(env.CRYPTO_MAX_UNIVERSE_SYMBOLS, 100));
}

function hours(tf) {
  if (tf === "1Min") return 4;
  if (tf === "5Min") return 36;
  if (tf === "15Min") return 120;
  return 240;
}

async function bars(env, symbols, tf, keep) {
  const out = Object.fromEntries(symbols.map(s => [s, []]));
  const start = new Date(Date.now() - hours(tf) * 3600000).toISOString();
  const joined = symbols.map(encodeURIComponent).join(",");
  let token = null, pages = 0;
  do {
    const page = token ? `&page_token=${encodeURIComponent(token)}` : "";
    const d = await marketDataRaw(env, `/v1beta3/crypto/us/bars?symbols=${joined}&timeframe=${encodeURIComponent(tf)}&start=${encodeURIComponent(start)}&limit=10000&sort=asc${page}`);
    const src = d?.bars || {};
    for (const s of symbols) if (Array.isArray(src[s])) out[s].push(...src[s]);
    token = d?.next_page_token || null;
    pages++;
  } while (token && pages < 4);
  for (const s of symbols) out[s] = out[s].slice(-keep);
  return out;
}

async function snapshots(env, symbols) {
  const d = await marketDataRaw(env, `/v1beta3/crypto/us/snapshots?symbols=${symbols.map(encodeURIComponent).join(",")}`);
  return d?.snapshots || d || {};
}

async function orderbooks(env, symbols) {
  const d = await marketDataRaw(env, `/v1beta3/crypto/us/latest/orderbooks?symbols=${symbols.map(encodeURIComponent).join(",")}`);
  return d?.orderbooks || d || {};
}

function bookMetrics(book) {
  const row = x => Array.isArray(x) ? { p: +(x[0] || 0), s: +(x[1] || 0) } : { p: +(x?.p ?? x?.price ?? 0), s: +(x?.s ?? x?.size ?? 0) };
  const bids = (book?.b || book?.bids || []).slice(0, 10).map(row);
  const asks = (book?.a || book?.asks || []).slice(0, 10).map(row);
  const bidDepth = bids.reduce((a,x) => a + x.p * x.s, 0), askDepth = asks.reduce((a,x) => a + x.p * x.s, 0), total = bidDepth + askDepth;
  return { bidDepth, askDepth, imbalance: total ? (bidDepth - askDepth) / total : 0 };
}

function scoreCandidate(base, h1, book) {
  const depth = bookMetrics(book);
  const flow = Boolean((base.s1?.ret1 > 0 && base.s1?.ret3 > 0) || (base.s5?.ret1 > 0 && base.s5?.ret3 > 0) || (base.s1?.ret1 > 0 && base.s5?.ret1 > 0));
  const setup = Boolean(base.s1?.momentum || base.s1?.breakout || base.s5?.momentum || base.s5?.breakout || base.s5?.pullback || (base.trendVotes >= 4 && flow));
  const higher = h1?.trend ? 10 : h1?.trendSlope ? 6 : h1?.downTrend ? -8 : 0;
  const bookBoost = depth.imbalance >= 0.2 ? 10 : depth.imbalance >= 0.1 ? 6 : depth.imbalance <= -0.25 ? -12 : depth.imbalance <= -0.1 ? -5 : 0;
  const velocityBoost = clamp(((base.s1?.ret3 || 0) * 700) + ((base.s5?.ret3 || 0) * 350), -10, 14);
  const score = base.score + higher + bookBoost + velocityBoost;
  const confirmed = Boolean(
    !base.halted && !base.nearLuld && !base.chop && flow && setup && base.trendVotes >= 3 &&
    (base.s5?.rsi14 ?? 50) >= 38 && (base.s5?.rsi14 ?? 50) <= 82 &&
    depth.imbalance > -0.3 && !(h1?.downTrend && score < 96)
  );
  return { ...base, h1, ...depth, cryptoScore: score, cryptoConfirmed: confirmed, cryptoFlow: flow, cryptoSetup: setup };
}

function regime(candidates) {
  const map = new Map(candidates.map(x => [x.symbol, x]));
  const anchors = ["BTC/USD","ETH/USD","SOL/USD"].map(s => map.get(s)).filter(Boolean);
  const shock = anchors.some(x => Math.abs(x.s1?.ret1 || 0) > 0.018 || x.spreadPct > 0.012);
  const bullish = anchors.filter(x => x.trendVotes >= 4 && x.s5?.ret1 > 0).length;
  const bearish = anchors.filter(x => x.shortVotes >= 4 && x.s5?.ret1 < 0).length;
  return shock ? "shock" : bullish >= 2 ? "bull" : bearish >= 2 ? "bear" : "mixed";
}

function threshold(mode, env) {
  const base = num(env.CRYPTO_MIN_ENTRY_SCORE, 82);
  if (mode === "bull") return Math.max(78, base - 2);
  if (mode === "mixed") return Math.max(82, base);
  if (mode === "bear") return Math.max(90, base + 8);
  return Math.max(94, base + 12);
}

function sizeMultiplier(mode) {
  if (mode === "shock") return 0.35;
  if (mode === "bear") return 0.55;
  if (mode === "mixed") return 0.8;
  return 1;
}

function recentCooldowns(orders, now, minutes) {
  const cut = Number(now) - minutes * 60000, out = new Set();
  for (const o of orders) {
    if (!isBotOrder(o) || o.side !== "sell" || o.status !== "filled") continue;
    const t = Date.parse(o.filled_at || 0);
    if (Number.isFinite(t) && t >= cut) out.add(norm(o.symbol));
  }
  return out;
}

async function research(env) {
  const assets = await universe(env), symbols = assets.map(a => a.symbol);
  if (!symbols.length) return { assets, candidates: [], mode: "none" };
  const [snaps,b1,b5,b15,b60,books] = await Promise.all([
    snapshots(env,symbols), bars(env,symbols,"1Min",55), bars(env,symbols,"5Min",70), bars(env,symbols,"15Min",60), bars(env,symbols,"1Hour",45), orderbooks(env,symbols)
  ]);
  const candidates = symbols.flatMap(symbol => {
    try {
      const base = combineSignals(symbol, timeframeSignal(symbol,b1[symbol]), timeframeSignal(symbol,b5[symbol]), timeframeSignal(symbol,b15[symbol]), snaps[symbol] || {});
      if (!base.valid) return [];
      return [scoreCandidate(base, timeframeSignal(symbol,b60[symbol]), books[symbol] || {})];
    } catch { return []; }
  });
  return { assets, candidates, mode: regime(candidates) };
}

function gates(x, minScore, minVol, minDepth, maxSpread, maxAge) {
  return {
    confirmed: Boolean(x.cryptoConfirmed),
    price: x.price > 0,
    volume: x.dollarVolume >= minVol,
    bidDepth: x.bidDepth >= minDepth,
    askDepth: x.askDepth >= minDepth,
    spread: x.spreadPct <= maxSpread,
    quoteAge: x.quoteAgeSec <= maxAge,
    score: x.cryptoScore >= minScore
  };
}

export async function cryptoOpportunityProbe(env) {
  if (!enabled(env)) return { enabled: false, endpoint: "paper" };
  const r = await research(env), minScore = threshold(r.mode, env);
  const minVol = num(env.CRYPTO_MIN_DOLLAR_VOLUME_USD, 1000000), minDepth = num(env.CRYPTO_MIN_QUOTE_NOTIONAL_USD, 1000), maxSpread = pct(env.CRYPTO_MAX_SPREAD_PCT, 0.004), maxAge = int(env.CRYPTO_MAX_QUOTE_AGE_SECONDS, 20);
  const ranked = r.candidates.filter(x => Object.values(gates(x,minScore,minVol,minDepth,maxSpread,maxAge)).every(Boolean)).sort((a,b) => b.cryptoScore - a.cryptoScore);
  const diagnostics = [...r.candidates].sort((a,b) => b.cryptoScore - a.cryptoScore).slice(0,12).map(x => ({
    symbol:x.symbol, score:round(x.cryptoScore,1), baseScore:round(x.score,1), price:round(x.price,8), spreadPct:round(x.spreadPct,5), quoteAgeSec:round(x.quoteAgeSec,1), dollarVolume:round(x.dollarVolume,0), bookImbalance:round(x.imbalance,3), bidDepthUsd:round(x.bidDepth,0), askDepthUsd:round(x.askDepth,0), trendVotes:x.trendVotes, flow:Boolean(x.cryptoFlow), setup:Boolean(x.cryptoSetup), h1Trend:Boolean(x.h1?.trend), h1Down:Boolean(x.h1?.downTrend), gates:gates(x,minScore,minVol,minDepth,maxSpread,maxAge)
  }));
  return {
    enabled: true, endpoint: "paper", market: "24x7", universeCount: r.assets.length, validSignals: r.candidates.length, mode: r.mode, threshold: minScore,
    thresholds:{minVol,minDepth,maxSpread,maxAge}, executableCount: ranked.length,
    leaders: ranked.slice(0,10).map(x => ({ symbol:x.symbol, score:round(x.cryptoScore,1), price:round(x.price,8), spreadPct:round(x.spreadPct,5), bookImbalance:round(x.imbalance,3), bidDepthUsd:round(x.bidDepth,0), askDepthUsd:round(x.askDepth,0), dollarVolume:round(x.dollarVolume,0), trendVotes:x.trendVotes, h1Trend:Boolean(x.h1?.trend) })),
    diagnostics
  };
}

export async function runCryptoOpportunityCycle(env, scheduledTime) {
  if (!enabled(env)) return { status:"disabled", endpoint:"paper" };
  const r = await research(env), minScore = threshold(r.mode, env);
  const [positions,openOrders,recentOrders,account] = await Promise.all([
    alpaca(env,"/v2/positions"), alpaca(env,"/v2/orders?status=open&direction=desc&nested=false"), alpaca(env,"/v2/orders?status=all&limit=500&direction=desc&nested=false"), alpaca(env,"/v2/account")
  ]);
  const cryptoAssets = new Set(r.assets.map(a => norm(a.symbol))), held = new Set(positions.filter(p => cryptoAssets.has(norm(p.symbol))).map(p => norm(p.symbol))), open = new Set(openOrders.filter(isBotOrder).map(o => norm(o.symbol)));
  const cooldown = recentCooldowns(recentOrders, scheduledTime, int(env.CRYPTO_SYMBOL_COOLDOWN_MINUTES, 10));
  const cryptoPositions = positions.filter(p => cryptoAssets.has(norm(p.symbol)) && Math.abs(+p.market_value || (+p.qty||0)*(+p.current_price||0)) > 1);
  const maxPositions = int(env.CRYPTO_MAX_CONCURRENT_POSITIONS,4), maxExposure = num(env.CRYPTO_MAX_TOTAL_EXPOSURE_USD,100000), currentExposure = cryptoPositions.reduce((a,p) => a + Math.abs(+p.market_value || (+p.qty||0)*(+p.current_price||0)),0);
  if (cryptoPositions.length >= maxPositions || currentExposure >= maxExposure) return { status:"capacity", mode:r.mode, positions:cryptoPositions.length, exposure:round(currentExposure,2) };

  const minVol = num(env.CRYPTO_MIN_DOLLAR_VOLUME_USD,1000000), minDepth = num(env.CRYPTO_MIN_QUOTE_NOTIONAL_USD,1000), maxSpread = pct(env.CRYPTO_MAX_SPREAD_PCT,0.004), maxAge = int(env.CRYPTO_MAX_QUOTE_AGE_SECONDS,20);
  const ranked = r.candidates.filter(x => {
    const k = norm(x.symbol);
    return !held.has(k) && !open.has(k) && !cooldown.has(k) && Object.values(gates(x,minScore,minVol,minDepth,maxSpread,maxAge)).every(Boolean);
  }).sort((a,b) => b.cryptoScore - a.cryptoScore);
  const best = ranked[0];
  if (!best) return { status:"hold", mode:r.mode, threshold:minScore, validSignals:r.candidates.length, executableCount:0 };

  const equity = Math.max(1,+account.equity||1), stop = clamp(Math.max(0.008,(best.s5?.atrPct||0.008)*0.9),0.005,0.02), riskBudget = equity * pct(env.CRYPTO_RISK_PER_TRADE_PCT,0.0035), riskBased = riskBudget / stop;
  const maxPosition = num(env.CRYPTO_MAX_POSITION_USD,25000), cap = num(env.CRYPTO_ORDER_NOTIONAL_USD,25000), remaining = Math.max(0,maxExposure-currentExposure), cash = Math.max(0,+(account.non_marginable_buying_power || account.cash || account.buying_power || 0));
  const notional = Math.min(riskBased,maxPosition,cap,remaining,cash) * sizeMultiplier(r.mode);
  if (notional < num(env.CRYPTO_MIN_ORDER_NOTIONAL_USD,25)) return { status:"insufficient_capacity", mode:r.mode, candidate:best.symbol };

  const id = `${PREFIX}buy-native-${norm(best.symbol)}-${Number(scheduledTime).toString(36)}`.slice(0,48);
  const order = await alpaca(env,"/v2/orders",{method:"POST",body:JSON.stringify({symbol:best.symbol,notional:round(notional,2).toFixed(2),side:"buy",type:"market",time_in_force:"gtc",client_order_id:id})});
  const result = { status:"ordered", endpoint:"paper", mode:r.mode, symbol:best.symbol, score:round(best.cryptoScore,1), threshold:minScore, notional:round(notional,2), orderId:order?.id || null, orderStatus:order?.status || null, spreadPct:round(best.spreadPct,5), bookImbalance:round(best.imbalance,3) };
  console.log(JSON.stringify({event:"crypto_native_entry",...result}));
  return result;
}

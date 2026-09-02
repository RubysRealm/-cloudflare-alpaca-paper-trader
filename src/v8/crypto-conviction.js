import { alpaca, marketDataRaw, recentNewsContext } from "./api.js";
import { timeframeSignal, combineSignals } from "./signals.js";
import { num, pct, int, clamp, round } from "./config.js";

export const CRYPTO_STRATEGY = "crypto-opportunity-v7";
export const CRYPTO_ORDER_PREFIX = "papercrypto-v7-";
const FALLBACK = ["BTC/USD","ETH/USD","SOL/USD","DOGE/USD","LTC/USD","AVAX/USD","LINK/USD","BCH/USD","UNI/USD","AAVE/USD"];
let universeCache = { at: 0, assets: [], source: "none" };

const norm = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const isCurrentOrder = o => String(o?.client_order_id || "").startsWith(CRYPTO_ORDER_PREFIX);
const isAnyCryptoBotOrder = o => String(o?.client_order_id || "").startsWith("papercrypto-");
const cid = (side, symbol, now, tag = "") => `${CRYPTO_ORDER_PREFIX}${side}-${tag}-${norm(symbol)}-${Number(now).toString(36)}`.slice(0, 48);
const baseAsset = symbol => String(symbol || "").toUpperCase().split("/")[0];

function cryptoEnabled(env) {
  return String(env.CRYPTO_TRADING_ENABLED ?? "true").toLowerCase() === "true";
}

export async function cryptoUniverse(env) {
  const refreshMs = int(env.CRYPTO_UNIVERSE_REFRESH_MINUTES, 1) * 60000;
  if (universeCache.assets.length && Date.now() - universeCache.at < refreshMs) return universeCache;
  try {
    const assets = await alpaca(env, "/v2/assets?status=active&asset_class=crypto");
    const usable = (Array.isArray(assets) ? assets : []).filter(a => a && a.symbol && a.status !== "inactive" && a.tradable !== false);
    if (usable.length) {
      universeCache = { at: Date.now(), assets: usable, source: "alpaca_assets_all_tradable_pairs" };
      return universeCache;
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "crypto_universe_degraded", message: error.message }));
  }
  const assets = String(env.CRYPTO_SYMBOLS || FALLBACK.join(","))
    .split(",")
    .map(symbol => ({ symbol: symbol.trim().toUpperCase(), tradable: true, status: "active", min_trade_increment: "0.00000001", price_increment: "0.00000001" }))
    .filter(a => a.symbol);
  universeCache = { at: Date.now(), assets, source: "fallback" };
  return universeCache;
}

function historyHours(timeframe) {
  if (timeframe === "1Min") return 4;
  if (timeframe === "5Min") return 36;
  if (timeframe === "15Min") return 120;
  return 240;
}

async function cryptoBars(env, symbols, timeframe, perSymbol) {
  const collected = Object.fromEntries(symbols.map(s => [s, []]));
  const start = new Date(Date.now() - historyHours(timeframe) * 3600000).toISOString();
  const joined = symbols.map(encodeURIComponent).join(",");
  let pageToken = null, pages = 0;
  do {
    const page = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
    const d = await marketDataRaw(env, `/v1beta3/crypto/us/bars?symbols=${joined}&timeframe=${encodeURIComponent(timeframe)}&start=${encodeURIComponent(start)}&limit=10000&sort=asc${page}`);
    const source = d?.bars || {};
    for (const symbol of symbols) {
      const arr = source[symbol] || source[norm(symbol)] || [];
      if (Array.isArray(arr)) collected[symbol].push(...arr);
    }
    pageToken = d?.next_page_token || d?.nextPageToken || null;
    pages++;
  } while (pageToken && pages < 4);
  const out = {};
  for (const symbol of symbols) out[symbol] = collected[symbol].slice(-perSymbol);
  return out;
}

async function cryptoSnapshots(env, symbols) {
  const d = await marketDataRaw(env, `/v1beta3/crypto/us/snapshots?symbols=${symbols.map(encodeURIComponent).join(",")}`);
  return d?.snapshots || d || {};
}

async function cryptoOrderbooks(env, symbols) {
  const d = await marketDataRaw(env, `/v1beta3/crypto/us/latest/orderbooks?symbols=${symbols.map(encodeURIComponent).join(",")}`);
  return d?.orderbooks || d || {};
}

function bookMetrics(book) {
  const row = x => Array.isArray(x)
    ? { price: +(x[0] || 0), size: +(x[1] || 0) }
    : { price: +(x?.p ?? x?.price ?? 0), size: +(x?.s ?? x?.size ?? 0) };
  const bids = (book?.b || book?.bids || []).slice(0, 10).map(row);
  const asks = (book?.a || book?.asks || []).slice(0, 10).map(row);
  const bidDepthUsd = bids.reduce((a, x) => a + x.price * x.size, 0);
  const askDepthUsd = asks.reduce((a, x) => a + x.price * x.size, 0);
  const total = bidDepthUsd + askDepthUsd;
  return { bidDepthUsd, askDepthUsd, imbalance: total > 0 ? (bidDepthUsd - askDepthUsd) / total : 0 };
}

function enrichResearch(base, h1, h4, book) {
  if (!base?.valid) return base;
  const depth = bookMetrics(book);
  const flow = Boolean(
    (base.s1?.ret1 > 0 && base.s1?.ret3 > 0) ||
    (base.s5?.ret1 > 0 && base.s5?.ret3 > 0) ||
    (base.s1?.ret1 > 0 && base.s5?.ret1 > 0) ||
    (base.s5?.ret3 > 0 && base.s15?.ret1 > 0)
  );
  const setup = Boolean(
    base.s1?.momentum || base.s1?.breakout || base.s5?.momentum || base.s5?.breakout || base.s5?.pullback ||
    (base.trendVotes >= 4 && flow)
  );
  const higherBoost = (h1?.trend ? 10 : h1?.downTrend ? -10 : 0) + (h4?.trend ? 9 : h4?.downTrend ? -9 : 0) + (h1?.trendSlope ? 4 : 0) + (h4?.trendSlope ? 3 : 0);
  const bookBoost = depth.imbalance >= 0.2 ? 10 : depth.imbalance >= 0.1 ? 6 : depth.imbalance <= -0.25 ? -12 : depth.imbalance <= -0.1 ? -5 : 0;
  const velocityBoost = clamp(((base.s1?.ret3 || 0) * 900) + ((base.s5?.ret3 || 0) * 480), -14, 20);
  const score = base.score + higherBoost + bookBoost + velocityBoost;
  const higherConflict = Boolean(h1?.downTrend && h4?.downTrend);
  const structurallyEligible = Boolean(
    !base.halted && !base.nearLuld && flow && setup && base.trendVotes >= 3 &&
    (base.s5?.rsi14 ?? 50) >= 36 && (base.s5?.rsi14 ?? 50) <= 86 &&
    depth.imbalance > -0.30 && !higherConflict
  );
  return {
    ...base,
    score,
    longConfirmed: structurallyEligible,
    structurallyEligible,
    h1,
    h4,
    cryptoFlow: flow,
    cryptoSetup: setup,
    bookImbalance: depth.imbalance,
    bidDepthUsd: depth.bidDepthUsd,
    askDepthUsd: depth.askDepthUsd,
    researchBoost: higherBoost + bookBoost + velocityBoost,
    higherTimeframeAligned: Boolean(h1?.trend && h4?.trend)
  };
}

function applyCrossMarketConfirmation(signals) {
  const groups = new Map();
  for (const signal of signals) {
    const key = baseAsset(signal.symbol);
    const arr = groups.get(key) || [];
    arr.push(signal);
    groups.set(key, arr);
  }
  return signals.map(signal => {
    const peers = groups.get(baseAsset(signal.symbol)) || [signal];
    const confirmedPeers = peers.filter(x => x.structurallyEligible).length;
    const averageScore = peers.reduce((a, x) => a + (x.score || 0), 0) / Math.max(1, peers.length);
    const crossBoost = clamp((confirmedPeers - 1) * 3 + Math.max(0, averageScore - 65) * 0.07, 0, 10);
    return { ...signal, score: signal.score + crossBoost, crossMarketConfirmed: confirmedPeers, crossMarketBoost: crossBoost };
  });
}

function cryptoRegime(signals) {
  const map = new Map(signals.map(s => [s.symbol, s]));
  const anchors = ["BTC/USD", "ETH/USD", "SOL/USD"].map(s => map.get(s)).filter(Boolean);
  const bullish = anchors.filter(s => s.structurallyEligible && (s.s5?.ret1 || 0) > 0).length;
  const bearish = anchors.filter(s => s.h1?.downTrend || s.h4?.downTrend).length;
  const shortSupport = anchors.filter(s => (s.s1?.ret3 || 0) > 0 && (s.s5?.ret1 || 0) >= 0).length;
  const shortWeakness = anchors.filter(s => (s.s1?.ret3 || 0) < -0.0015 || (s.s5?.ret1 || 0) < -0.0015).length;
  const shock = anchors.some(s => Math.abs(s.s1?.ret1 || 0) > 0.018 || s.spreadPct > 0.012);
  const mode = shock ? "shock" : bullish >= 2 && shortSupport >= 2 ? "bull" : bearish >= 2 || shortWeakness >= 2 ? "bear" : "mixed";
  const marketWeight = shock ? 0 : mode === "bull" ? 1.15 : mode === "bear" ? 0.72 : 1;
  return { mode, shock, shortTermSupport: shortSupport, shortTermWeakness: shortWeakness, broadLongOk: !shock && mode !== "bear", marketWeight };
}

function entryEconomics(signal, env) {
  const fee = pct(env.CRYPTO_TAKER_FEE_PCT, 0.0025);
  const entrySlip = pct(env.CRYPTO_MAX_ENTRY_SLIPPAGE_PCT, 0.0015);
  const exitSlip = pct(env.CRYPTO_MAX_EXIT_SLIPPAGE_PCT, 0.0015);
  const roundTripCost = fee * 2 + Math.max(0, signal?.spreadPct || 0) + entrySlip + exitSlip;
  const expectedGrossMove = clamp(Math.max(
    (signal?.atrPct || 0) * 1.9,
    Math.max(0, signal?.s5?.ret3 || 0) * 1.6,
    Math.max(0, signal?.s15?.ret1 || 0) * 1.35,
    Math.max(0, signal?.h1?.ret1 || 0) * 0.9,
    0.0005
  ), 0.0005, 0.08);
  const expectedNetEdge = expectedGrossMove - roundTripCost;
  const rewardToCost = roundTripCost > 0 ? expectedGrossMove / roundTripCost : 99;
  return { roundTripCost, expectedGrossMove, expectedNetEdge, rewardToCost, ok: expectedNetEdge > 0 };
}

function applyOpportunityResearch(signal, news, regime) {
  const catalystScore = news?.score || 0;
  const adjustedScore = signal.score + catalystScore;
  const probability = clamp(
    0.40 + Math.max(0, adjustedScore - 60) * 0.0042 + (signal.trendVotes || 0) * 0.019 +
    (signal.h1?.trend ? 0.05 : 0) + (signal.h4?.trend ? 0.045 : 0) + (signal.cryptoFlow ? 0.04 : 0) +
    clamp((signal.bookImbalance || 0) * 0.14, -0.09, 0.09) + clamp(catalystScore / 100, -0.18, 0.12),
    0.18, 0.93
  );
  const movementOpportunity = Math.max(
    signal.atrPct || 0,
    Math.max(0, signal.s1?.ret3 || 0) * 1.8,
    Math.max(0, signal.s5?.ret3 || 0) * 1.5,
    Math.max(0, signal.s15?.ret1 || 0) * 1.2
  );
  const movementMultiplier = 1 + clamp(movementOpportunity * 60, 0, 3.5);
  const opportunityScore = Math.max(0, signal.entryEconomics?.expectedNetEdge || 0) * probability * movementMultiplier * Math.max(0, regime.marketWeight || 0);
  return { ...signal, score: adjustedScore, probability, movementOpportunity, opportunityScore, catalyst: news || { score: 0, positive: 0, negative: 0, severe: false, headlines: [] } };
}

function barTimeMs(bar) {
  const t = bar?.t ?? bar?.timestamp ?? bar?.time;
  const ms = typeof t === "number" ? (t > 1e12 ? t : t * 1000) : Date.parse(t || 0);
  return Number.isFinite(ms) ? ms : 0;
}

function barHigh(bar) {
  return +(bar?.h ?? bar?.high ?? bar?.c ?? bar?.close ?? 0);
}

function latestEntryTimes(orders) {
  const out = new Map();
  for (const o of orders) {
    if (!isAnyCryptoBotOrder(o) || o.side !== "buy" || o.status !== "filled") continue;
    const at = Date.parse(o.filled_at || o.submitted_at || 0), key = norm(o.symbol);
    if (!Number.isFinite(at)) continue;
    const prev = out.get(key);
    if (!prev || at > prev.at) out.set(key, { at, price: +(o.filled_avg_price || 0) });
  }
  return out;
}

function peakPriceSinceEntry(entryPrice, currentPrice, entryMeta, bars1, bars5) {
  let peak = Math.max(entryPrice || 0, currentPrice || 0);
  const start = entryMeta?.at || 0;
  if (!start) return peak;
  for (const bar of [...(bars5 || []), ...(bars1 || [])]) {
    if (barTimeMs(bar) + 300000 < start) continue;
    peak = Math.max(peak, barHigh(bar));
  }
  return peak;
}

function profitExitDecision(position, signal, peakPrice, bestAlternative) {
  const entry = +position.avg_entry_price || 0;
  const bid = +(signal?.bid || signal?.price || position.current_price || 0);
  if (!(entry > 0 && bid > 0)) return { exit: false, reason: "hold_no_quote", pnlPct: 0, peakPnlPct: 0 };
  const pnlPct = bid / entry - 1;
  const peak = Math.max(entry, +(peakPrice || 0), bid);
  const peakPnlPct = peak / entry - 1;
  if (!(pnlPct > 0)) return { exit: false, reason: peakPnlPct > 0 ? "hold_recovery_after_profit" : "hold_until_profitable", pnlPct, peakPnlPct };

  const retracePct = peak > 0 ? Math.max(0, (peak - bid) / peak) : 0;
  const shortTermRollover = Boolean(signal && signal.s1?.ret1 < 0 && (signal.s1?.ret3 < 0 || signal.s5?.ret1 <= 0));
  const dynamicNoise = Math.max((signal?.atrPct || 0.002) * 0.3, Math.abs(signal?.s1?.ret1 || 0) * 0.4, 0.0003);
  const heavyReversal = shortTermRollover && retracePct > dynamicNoise;
  const currentOpportunity = signal?.opportunityScore || 0;
  const alternativeOpportunity = bestAlternative?.opportunityScore || 0;
  const rotate = Boolean(bestAlternative && norm(bestAlternative.symbol) !== norm(signal?.symbol) && alternativeOpportunity > Math.max(currentOpportunity * 1.2, currentOpportunity + 0.00015));
  const edgeLost = Boolean(signal?.catalyst?.severe || currentOpportunity <= 0 || !signal?.structurallyEligible);
  const exit = pnlPct > 0 && (rotate || edgeLost || heavyReversal);
  return {
    exit,
    reason: rotate ? "profit_rotate_stronger_opportunity" : edgeLost ? "profit_edge_lost" : heavyReversal ? "profit_reversal" : "ride_best_opportunity",
    pnlPct,
    peakPnlPct,
    retracePct,
    dynamicNoise
  };
}

function currentPerformance(orders) {
  const inventory = {}, trades = [];
  for (const o of [...orders].filter(o => isCurrentOrder(o) && o.status === "filled" && o.filled_avg_price).sort((a, b) => String(a.filled_at || "").localeCompare(String(b.filled_at || "")))) {
    const key = norm(o.symbol), qty = Math.abs(+o.filled_qty || 0), price = +o.filled_avg_price || 0;
    if (!(qty > 0 && price > 0)) continue;
    const x = inventory[key] ||= { qty: 0, cost: 0 };
    if (o.side === "buy") { x.qty += qty; x.cost += qty * price; continue; }
    if (!(x.qty > 0)) continue;
    const sold = Math.min(qty, x.qty), avg = x.cost / x.qty, pnl = sold * (price - avg);
    trades.push({ symbol: key, pnl, at: o.filled_at });
    x.qty -= sold; x.cost -= sold * avg;
    if (x.qty < 1e-10) { x.qty = 0; x.cost = 0; }
  }
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = losses.reduce((a, t) => a + Math.abs(t.pnl), 0), realizedPnl = trades.reduce((a, t) => a + t.pnl, 0);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    realizedPnl,
    expectancy: trades.length ? realizedPnl / trades.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? 99 : 0
  };
}

function formatSellQty(qty, asset) {
  const inc = Math.max(1e-12, +(asset?.min_trade_increment || asset?.min_order_size || 0.00000001));
  const units = Math.floor((qty + inc * 1e-8) / inc), value = units * inc;
  const text = String(asset?.min_trade_increment || asset?.min_order_size || "0.00000001");
  const decimals = text.includes(".") ? text.split(".")[1].replace(/0+$/, "").length || text.split(".")[1].length : 8;
  return Math.max(0, value).toFixed(Math.min(12, Math.max(0, decimals)));
}

function formatLimitPrice(price, asset) {
  const inc = Math.max(1e-12, +(asset?.price_increment || 0.00000001));
  const units = Math.ceil(price / inc), value = units * inc;
  const text = String(asset?.price_increment || "0.00000001");
  const decimals = text.includes(".") ? text.split(".")[1].replace(/0+$/, "").length || text.split(".")[1].length : 8;
  return Math.max(inc, value).toFixed(Math.min(12, Math.max(0, decimals)));
}

async function placeCryptoBuy(env, candidate, asset, notional, now) {
  if (!(candidate.ask > 0)) throw new Error("crypto_entry_missing_ask");
  const maxSlip = pct(env.CRYPTO_MAX_ENTRY_SLIPPAGE_PCT, 0.0015);
  const limitPrice = formatLimitPrice(candidate.ask * (1 + maxSlip), asset);
  return alpaca(env, "/v2/orders", {
    method: "POST",
    body: JSON.stringify({ symbol: candidate.symbol, notional: round(notional, 2).toFixed(2), side: "buy", type: "limit", limit_price: limitPrice, time_in_force: "ioc", client_order_id: cid("buy", candidate.symbol, now, "opportunity") })
  });
}

async function placeProfitProtectCryptoSell(env, position, asset, signal, now, decision) {
  const symbol = signal?.symbol || asset?.symbol || position.symbol;
  const qty = formatSellQty(Math.abs(+position.qty || 0), asset);
  if (!(+qty > 0)) throw new Error("crypto_exit_quantity_too_small");
  const entry = +position.avg_entry_price || 0;
  const bid = +(signal?.bid || signal?.price || position.current_price || 0);
  const inc = Math.max(1e-12, +(asset?.price_increment || 0.00000001));
  const profitFloor = entry + inc;
  if (!(bid > profitFloor)) throw new Error("crypto_profit_disappeared_before_exit");
  const slip = pct(env.CRYPTO_MAX_EXIT_SLIPPAGE_PCT, 0.0015);
  const marketableFloor = bid * (1 - slip);
  const limitPrice = formatLimitPrice(Math.max(profitFloor, marketableFloor), asset);
  return alpaca(env, "/v2/orders", {
    method: "POST",
    body: JSON.stringify({ symbol, qty, side: "sell", type: "limit", limit_price: limitPrice, time_in_force: "ioc", client_order_id: cid("sell", symbol, now, decision.reason.includes("rotate") ? "rotate" : "profit") })
  });
}

export async function runCryptoCycle(env, scheduledTime) {
  if (!cryptoEnabled(env)) return { status: "disabled", strategy: CRYPTO_STRATEGY, endpoint: "paper", market: "24x7" };
  if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) throw new Error("missing_alpaca_secrets");

  const u = await cryptoUniverse(env), assets = u.assets, symbols = assets.map(a => a.symbol);
  if (!symbols.length) return { status: "no_crypto_assets", strategy: CRYPTO_STRATEGY, endpoint: "paper", market: "24x7" };

  const [snapshots, b1, b5, b15, b60, b240, orderbooks] = await Promise.all([
    cryptoSnapshots(env, symbols),
    cryptoBars(env, symbols, "1Min", 55),
    cryptoBars(env, symbols, "5Min", 80),
    cryptoBars(env, symbols, "15Min", 70),
    cryptoBars(env, symbols, "1Hour", 60),
    cryptoBars(env, symbols, "4Hour", 48),
    cryptoOrderbooks(env, symbols)
  ]);

  const rawSignals = symbols.map(symbol => {
    try {
      const snap = snapshots[symbol] || snapshots[norm(symbol)] || {};
      const base = combineSignals(symbol, timeframeSignal(symbol, b1[symbol]), timeframeSignal(symbol, b5[symbol]), timeframeSignal(symbol, b15[symbol]), snap);
      return enrichResearch(base, timeframeSignal(symbol, b60[symbol]), timeframeSignal(symbol, b240[symbol]), orderbooks[symbol] || orderbooks[norm(symbol)] || {});
    } catch (error) {
      console.log(JSON.stringify({ event: "crypto_signal_failed", symbol, message: error.message }));
      return { symbol, valid: false };
    }
  }).filter(s => s.valid);

  const crossSignals = applyCrossMarketConfirmation(rawSignals);
  const regime = cryptoRegime(crossSignals);
  const minDepth = num(env.CRYPTO_MIN_QUOTE_NOTIONAL_USD, 1000);
  const maxSpread = pct(env.CRYPTO_MAX_SPREAD_PCT, 0.004);
  const maxAge = int(env.CRYPTO_MAX_QUOTE_AGE_SECONDS, 20);
  const news = await recentNewsContext(env, crossSignals.map(s => norm(s.symbol)), scheduledTime, 120);
  const signals = crossSignals.map(s => {
    const withEconomics = { ...s, entryEconomics: entryEconomics(s, env) };
    return applyOpportunityResearch(withEconomics, news.get(norm(s.symbol)), regime);
  });
  const signalByNorm = new Map(signals.map(s => [norm(s.symbol), s]));
  const assetByNorm = new Map(assets.map(a => [norm(a.symbol), a]));

  const marketLeaders = signals.filter(s =>
    String(s.symbol).toUpperCase().endsWith("/USD") && !regime.shock && !s.catalyst?.severe &&
    s.structurallyEligible && s.price > 0 && s.bidDepthUsd >= minDepth && s.askDepthUsd >= minDepth &&
    s.spreadPct <= maxSpread && s.quoteAgeSec <= maxAge && s.entryEconomics.ok &&
    (!s.chop || s.movementOpportunity >= 0.006 || (s.catalyst?.positive || 0) > 0)
  ).sort((a, b) => (b.opportunityScore - a.opportunityScore) || (b.probability - a.probability) || (b.score - a.score));

  const [positions, openOrders, recentOrders, account] = await Promise.all([
    alpaca(env, "/v2/positions"),
    alpaca(env, "/v2/orders?status=open&direction=desc&nested=false"),
    alpaca(env, "/v2/orders?status=all&limit=500&direction=desc&nested=false"),
    alpaca(env, "/v2/account")
  ]);

  const currentOpen = new Set(openOrders.filter(isAnyCryptoBotOrder).map(o => norm(o.symbol)));
  const entryTimes = latestEntryTimes(recentOrders);
  const botPositions = (Array.isArray(positions) ? positions : []).flatMap(p => {
    const key = norm(p.symbol), asset = assetByNorm.get(key), signal = signalByNorm.get(key);
    if (!asset) return [];
    const qty = Math.abs(+p.qty || 0), currentPrice = +(signal?.price || p.current_price || 0);
    if (!(qty > 1e-10) || qty * currentPrice <= 1) return [];
    return [{ ...p, qty: String(qty), current_price: String(currentPrice), _key: key }];
  });

  const actions = [];
  for (const position of botPositions) {
    if (currentOpen.has(position._key)) continue;
    const signal = signalByNorm.get(position._key);
    const asset = assetByNorm.get(position._key);
    const symbol = signal?.symbol || asset?.symbol;
    const peakPrice = peakPriceSinceEntry(+position.avg_entry_price || 0, +(signal?.bid || signal?.price || position.current_price || 0), entryTimes.get(position._key), b1[symbol] || [], b5[symbol] || []);
    const bestAlternative = marketLeaders.find(x => norm(x.symbol) !== position._key) || null;
    const decision = profitExitDecision(position, signal, peakPrice, bestAlternative);
    if (!decision.exit) continue;
    try {
      const order = await placeProfitProtectCryptoSell(env, position, asset, signal, scheduledTime, decision);
      actions.push({ action: "crypto_sell", symbol: signal?.symbol || position.symbol, reason: decision.reason, pnlPct: round(decision.pnlPct, 5), peakPnlPct: round(decision.peakPnlPct, 5), alternative: bestAlternative?.symbol || null, orderStatus: order?.status || null, limitPrice: +(order?.limit_price || 0) });
      currentOpen.add(position._key);
    } catch (error) {
      console.log(JSON.stringify({ event: "crypto_exit_failed", symbol: position.symbol, reason: decision.reason, message: error.message }));
    }
  }

  const occupied = new Set(botPositions.map(p => p._key));
  const ranked = marketLeaders.filter(s => !occupied.has(norm(s.symbol)) && !currentOpen.has(norm(s.symbol)));
  const maxPositions = int(env.CRYPTO_MAX_CONCURRENT_POSITIONS, 2);
  const maxTotal = num(env.CRYPTO_MAX_TOTAL_EXPOSURE_USD, 50000);
  const maxNew = int(env.CRYPTO_MAX_NEW_ENTRIES_PER_CYCLE, 1);
  const currentExposure = botPositions.reduce((a, p) => a + Math.abs((+p.qty || 0) * (+p.current_price || 0)), 0);
  let slots = Math.max(0, maxPositions - botPositions.length), remaining = Math.max(0, maxTotal - currentExposure), newEntries = 0;
  const cashLike = Math.max(0, +(account.non_marginable_buying_power || account.cash || account.buying_power || 0));

  for (let rank = 0; rank < ranked.length; rank++) {
    const candidate = ranked[rank];
    if (regime.shock || slots <= 0 || remaining < 1 || newEntries >= maxNew) break;
    const baseCap = Math.min(num(env.CRYPTO_ORDER_NOTIONAL_USD, 25000), num(env.CRYPTO_MAX_POSITION_USD, 25000), remaining, cashLike);
    const convictionScale = clamp(0.55 + candidate.probability * 0.55 + Math.min(0.35, candidate.movementOpportunity * 15), 0.55, 1.15);
    const marketScale = regime.mode === "bear" ? 0.65 : regime.mode === "bull" ? 1 : 0.85;
    const notional = Math.min(baseCap, baseCap * convictionScale * marketScale);
    if (notional < num(env.CRYPTO_MIN_ORDER_NOTIONAL_USD, 25)) continue;
    try {
      const order = await placeCryptoBuy(env, candidate, assetByNorm.get(norm(candidate.symbol)), notional, scheduledTime);
      actions.push({
        action: "crypto_buy",
        symbol: candidate.symbol,
        reason: "best_relative_probability_weighted_opportunity",
        relativeRank: rank + 1,
        score: round(candidate.score, 1),
        regime: regime.mode,
        shortTermMarketSupport: regime.shortTermSupport,
        crossMarketConfirmed: candidate.crossMarketConfirmed,
        probability: round(candidate.probability, 3),
        opportunityScore: round(candidate.opportunityScore, 6),
        movementOpportunity: round(candidate.movementOpportunity, 5),
        catalystScore: round(candidate.catalyst?.score || 0, 2),
        expectedNetEdgePct: round(candidate.entryEconomics.expectedNetEdge, 5),
        expectedGrossMovePct: round(candidate.entryEconomics.expectedGrossMove, 5),
        rewardToCost: round(candidate.entryEconomics.rewardToCost, 2),
        notional: round(notional, 2),
        orderStatus: order?.status || null,
        limitPrice: +(order?.limit_price || 0)
      });
      slots--; remaining -= notional; newEntries++;
    } catch (error) {
      console.log(JSON.stringify({ event: "crypto_entry_failed", symbol: candidate.symbol, message: error.message }));
    }
  }

  const perf = currentPerformance(recentOrders);
  const result = {
    status: actions.length ? "acted" : "hold",
    strategy: CRYPTO_STRATEGY,
    endpoint: "paper",
    market: "24x7",
    universeSource: u.source,
    universeCount: symbols.length,
    allActiveTradablePairs: true,
    eligibleOpportunities: marketLeaders.length,
    research: {
      cycleMinutes: 1,
      universeRefreshMinutes: int(env.CRYPTO_UNIVERSE_REFRESH_MINUTES, 1),
      timeframes: ["1Min", "5Min", "15Min", "1Hour", "4Hour"],
      orderBookDepth: true,
      crossMarketConfirmation: true,
      broadMarketAnchorAsWeight: true,
      broadMarketAnchorHardGate: false,
      scansAllQuoteMarkets: true,
      selectiveConviction: true,
      relativeOpportunityRanking: true,
      absoluteScoreGate: false,
      tradeVolumeObjective: false,
      probabilityWeightedRanking: true,
      movementOpportunityRanking: true,
      catalystAware: true,
      fixedProfitThreshold: false,
      positiveNetEdgeRequired: true,
      opportunityCostExit: true,
      singleEngineOwnership: true,
      priceProtectedIocEntries: true,
      profitProtectedIocExits: true,
      fixedProfitTarget: false,
      dynamicProfitProtection: true,
      profitToLossGuard: true,
      normalLossTakingExits: false,
      costAwareEntries: true
    },
    regime,
    performance: { realizedPnl: round(perf.realizedPnl, 2), trades: perf.trades, wins: perf.wins, losses: perf.losses, winRate: round(perf.winRate, 4), profitFactor: round(perf.profitFactor, 3), expectancy: round(perf.expectancy, 2) },
    risk: { exposure: round(currentExposure, 2), maxExposure: maxTotal },
    actions,
    leaders: marketLeaders.slice(0, 8).map((s,i) => ({ rank:i+1, symbol: s.symbol, score: round(s.score, 1), probability: round(s.probability,3), opportunityScore: round(s.opportunityScore,6), movementOpportunity: round(s.movementOpportunity,5), catalystScore: round(s.catalyst?.score || 0,2), catalystHeadlines: (s.catalyst?.headlines || []).slice(0,2), expectedNetEdgePct: round(s.entryEconomics?.expectedNetEdge || 0, 5), expectedGrossMovePct: round(s.entryEconomics?.expectedGrossMove || 0, 5), rewardToCost: round(s.entryEconomics?.rewardToCost || 0, 2), spreadPct: round(s.spreadPct, 5), bookImbalance: round(s.bookImbalance || 0, 3), h1Trend: Boolean(s.h1?.trend), h4Trend: Boolean(s.h4?.trend), crossMarketConfirmed: s.crossMarketConfirmed }))
  };
  console.log(JSON.stringify({ event: "crypto_cycle_complete", ...result }));
  return result;
}

export async function cryptoStatus(env) {
  const u = await cryptoUniverse(env), sampleSymbols = u.assets.slice(0, 5).map(a => a.symbol);
  let marketDataReachable = false, orderBookReachable = false, account = {};
  try { if (sampleSymbols.length) { await cryptoSnapshots(env, sampleSymbols); marketDataReachable = true; } } catch {}
  try { if (sampleSymbols.length) { await cryptoOrderbooks(env, sampleSymbols); orderBookReachable = true; } } catch {}
  try { account = await alpaca(env, "/v2/account"); } catch {}
  const quoteMarkets = [...new Set(u.assets.map(a => String(a.symbol || "").split("/")[1]).filter(Boolean))].sort();
  const uniqueCryptoAssets = new Set(u.assets.map(a => baseAsset(a.symbol)).filter(Boolean)).size;
  return {
    strategy: CRYPTO_STRATEGY,
    orderPrefix: CRYPTO_ORDER_PREFIX,
    enabled: cryptoEnabled(env),
    endpoint: "paper",
    market: "24x7",
    universeSource: u.source,
    universeCount: u.assets.length,
    uniqueCryptoAssets,
    quoteMarkets,
    allActiveTradablePairs: true,
    sampleSymbols,
    marketDataReachable,
    orderBookReachable,
    research: {
      cycleMinutes: 1,
      universeRefreshMinutes: int(env.CRYPTO_UNIVERSE_REFRESH_MINUTES, 1),
      timeframes: ["1Min", "5Min", "15Min", "1Hour", "4Hour"],
      orderBookDepth: true,
      crossMarketConfirmation: true,
      broadMarketAnchorAsWeight: true,
      broadMarketAnchorHardGate: false,
      scansAllQuoteMarkets: true,
      selectiveConviction: true,
      relativeOpportunityRanking: true,
      absoluteScoreGate: false,
      tradeVolumeObjective: false,
      probabilityWeightedRanking: true,
      movementOpportunityRanking: true,
      catalystAware: true,
      fixedProfitThreshold: false,
      positiveNetEdgeRequired: true,
      opportunityCostExit: true,
      singleEngineOwnership: true,
      priceProtectedIocEntries: true,
      profitProtectedIocExits: true,
      fixedProfitTarget: false,
      dynamicProfitProtection: true,
      profitToLossGuard: true,
      normalLossTakingExits: false,
      costAwareEntries: true
    },
    cryptoAccountStatus: account.crypto_status || null,
    maxConcurrentPositions: int(env.CRYPTO_MAX_CONCURRENT_POSITIONS, 2),
    maxTotalExposureUsd: num(env.CRYPTO_MAX_TOTAL_EXPOSURE_USD, 50000),
    orderNotionalUsd: num(env.CRYPTO_ORDER_NOTIONAL_USD, 25000),
    fixedProfitTargetPct: 0
  };
}

import { alpaca, marketDataRaw } from "./api.js";
import { timeframeSignal, combineSignals } from "./signals.js";
import { adaptiveLearning } from "./performance.js";
import { num, pct, int, clamp, round, etDateKey } from "./config.js";

export const CRYPTO_STRATEGY = "crypto-profitability-v1";
const CRYPTO_PREFIX = "papercrypto-";
const FALLBACK = ["BTC/USD","ETH/USD","SOL/USD","DOGE/USD","LTC/USD","AVAX/USD","LINK/USD","BCH/USD","UNI/USD","AAVE/USD"];
let universeCache = { at: 0, assets: [], source: "none" };

const norm = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const isCryptoOrder = o => String(o?.client_order_id || "").startsWith(CRYPTO_PREFIX);
const cid = (side, symbol, now, tag = "") => `${CRYPTO_PREFIX}${side}-${tag}-${norm(symbol)}-${Number(now).toString(36)}`.slice(0, 48);

function cryptoEnabled(env) { return String(env.CRYPTO_TRADING_ENABLED ?? "true").toLowerCase() === "true"; }

export async function cryptoUniverse(env) {
  const refreshMs = int(env.CRYPTO_UNIVERSE_REFRESH_MINUTES, 15) * 60000;
  if (universeCache.assets.length && Date.now() - universeCache.at < refreshMs) return universeCache;
  try {
    const assets = await alpaca(env, "/v2/assets?status=active&asset_class=crypto");
    const usable = (Array.isArray(assets) ? assets : []).filter(a => {
      const s = String(a.symbol || "").toUpperCase();
      return a.status !== "inactive" && a.tradable !== false && a.fractionable !== false && (s.endsWith("/USD") || (!s.includes("/") && s.endsWith("USD")));
    });
    if (usable.length) {
      universeCache = { at: Date.now(), assets: usable, source: "alpaca_assets" };
      return universeCache;
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "crypto_universe_degraded", message: error.message }));
  }
  const assets = String(env.CRYPTO_SYMBOLS || FALLBACK.join(",")).split(",").map(symbol => ({ symbol: symbol.trim().toUpperCase(), tradable: true, fractionable: true, status: "active", min_trade_increment: "0.00000001" })).filter(a => a.symbol);
  universeCache = { at: Date.now(), assets, source: "fallback" };
  return universeCache;
}

function historyHours(timeframe) {
  const m = String(timeframe).match(/^(\d+)Min$/i);
  if (!m) return 168;
  const mins = Number(m[1]);
  if (mins <= 1) return 4;
  if (mins <= 5) return 36;
  return 120;
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
  const joined = symbols.map(encodeURIComponent).join(",");
  const d = await marketDataRaw(env, `/v1beta3/crypto/us/snapshots?symbols=${joined}`);
  return d?.snapshots || d || {};
}

function cryptoRegime(signals) {
  const valid = signals.filter(s => s.valid);
  const map = new Map(valid.map(s => [s.symbol, s]));
  const anchors = ["BTC/USD","ETH/USD","SOL/USD"].map(s => map.get(s)).filter(Boolean);
  const breadth = valid.reduce((a, s) => a + (s.longAligned ? 1 : s.shortAligned ? -1 : 0), 0) / Math.max(1, valid.length);
  const shock = anchors.some(s => Math.abs(s.s1?.ret1 || 0) > 0.015 || s.spreadPct > 0.01);
  const longs = anchors.filter(s => s.longAligned).length, shorts = anchors.filter(s => s.shortAligned).length;
  const mode = shock ? "shock" : longs >= 2 && breadth > 0.08 ? "bull" : shorts >= 2 && breadth < -0.08 ? "bear" : "sideways";
  return { mode, breadth: round(breadth, 3), shock };
}

function requiredScore(regime, learning, env) {
  const base = Math.max(78, learning.scoreThreshold || num(env.CRYPTO_MIN_ENTRY_SCORE, 82));
  if (regime.mode === "bull") return base;
  if (regime.mode === "sideways") return Math.max(base + 6, 88);
  if (regime.mode === "bear") return Math.max(base + 12, 94);
  return Math.max(base + 4, 86);
}

function exitParams(signal, env) {
  const a = signal?.atrPct || 0.008;
  const base = pct(env.CRYPTO_STOP_LOSS_PCT, 0.008), min = pct(env.CRYPTO_MIN_STOP_LOSS_PCT, 0.005), max = pct(env.CRYPTO_MAX_STOP_LOSS_PCT, 0.02);
  const stop = clamp(Math.max(base, a * 0.9), min, max), rr = num(env.CRYPTO_TARGET_R_MULTIPLE, 2.4), target = clamp(stop * rr, 0.012, 0.06);
  return { stop, target, trailTrigger: clamp(Math.max(stop * 1.15, target * 0.55), 0.008, 0.035), trailGiveback: clamp(stop * 0.5, 0.003, 0.012) };
}

function cryptoExitDecision(position, signal, env, regime) {
  const entry = +position.avg_entry_price, price = signal?.price || +position.current_price, p = exitParams(signal, env);
  const pnl = entry > 0 ? price / entry - 1 : 0, scoreFloor = num(env.CRYPTO_MIN_ENTRY_SCORE, 82);
  if (pnl <= -p.stop) return { exit: true, reason: "dynamic_stop", pnlPct: pnl };
  if (signal && pnl <= -0.0025 && (!signal.longConfirmed || signal.score < scoreFloor * 0.85 || (signal.s1?.ret1 < 0 && signal.s5?.ret1 < 0))) return { exit: true, reason: "thesis_failed", pnlPct: pnl };
  if (regime.mode === "bear" && signal && (signal.score < 94 || !signal.longAligned)) return { exit: true, reason: "regime_weakness", pnlPct: pnl };
  if (pnl >= p.target) return { exit: true, reason: "dynamic_target", pnlPct: pnl };
  if (pnl >= p.trailTrigger && signal && price < signal.s5.ema9 * (1 - p.trailGiveback)) return { exit: true, reason: "adaptive_trail", pnlPct: pnl };
  const protectAt = Math.max(0.007, p.stop * 0.8);
  if (pnl >= protectAt && signal && (!signal.longConfirmed || signal.score < scoreFloor) && price < signal.s5.ema9) return { exit: true, reason: "profit_protect", pnlPct: pnl };
  if (signal && pnl <= -Math.max(0.0035, p.stop * 0.45) && ((!signal.s5.trend && !signal.s15.trend) || (price < signal.s5.vwap && price < signal.s15.vwap))) return { exit: true, reason: "trend_failure", pnlPct: pnl };
  return { exit: false, reason: "hold", pnlPct: pnl };
}

function cryptoLots(orders) {
  const lots = {};
  for (const o of [...orders].filter(o => o.status === "filled" && o.filled_avg_price && isCryptoOrder(o)).sort((a,b) => String(a.filled_at || "").localeCompare(String(b.filled_at || "")))) {
    const key = norm(o.symbol), q = Math.abs(+o.filled_qty || 0), p = +o.filled_avg_price || 0;
    if (!(q > 0 && p > 0)) continue;
    const x = lots[key] ||= { qty: 0, cost: 0, avgEntry: 0 };
    if (o.side === "buy") { x.cost += q * p; x.qty += q; }
    else if (x.qty > 0) { const sold = Math.min(q, x.qty), avg = x.cost / x.qty; x.qty -= sold; x.cost -= sold * avg; }
    if (x.qty < 1e-10) { x.qty = 0; x.cost = 0; x.avgEntry = 0; } else x.avgEntry = x.cost / x.qty;
  }
  return lots;
}

function cryptoPerformance(orders) {
  const inv = {}, pnls = [], trades = [];
  let realizedPnl = 0, wins = 0, losses = 0, grossWin = 0, grossLoss = 0, consecLoss = 0, maxConsecLoss = 0;
  for (const o of [...orders].filter(o => o.status === "filled" && o.filled_avg_price && isCryptoOrder(o)).sort((a,b) => String(a.filled_at || "").localeCompare(String(b.filled_at || "")))) {
    const key = norm(o.symbol), q = Math.abs(+o.filled_qty || 0), p = +o.filled_avg_price || 0;
    if (!(q > 0 && p > 0)) continue;
    const x = inv[key] ||= { qty: 0, cost: 0 };
    if (o.side === "buy") { x.cost += q * p; x.qty += q; continue; }
    if (x.qty <= 0) continue;
    const sold = Math.min(q, x.qty), avg = x.cost / x.qty, pnl = sold * (p - avg);
    realizedPnl += pnl; pnls.push(pnl); trades.push({ pnl, at: o.filled_at }); x.qty -= sold; x.cost -= sold * avg;
    if (pnl > 0) { wins++; grossWin += pnl; consecLoss = 0; } else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); consecLoss++; maxConsecLoss = Math.max(maxConsecLoss, consecLoss); }
  }
  const count = pnls.length, expectancy = count ? realizedPnl / count : 0, profitFactor = grossLoss ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  return { realizedPnl, trades: count, wins, losses, winRate: count ? wins / count : 0, grossWin, grossLoss, profitFactor, expectancy, maxConsecLoss, pnls, tradeEvents: trades };
}

function formatSellQty(qty, asset) {
  const inc = Math.max(1e-12, +(asset?.min_trade_increment || asset?.min_order_size || 0.00000001));
  const units = Math.floor((qty + inc * 1e-8) / inc), value = units * inc;
  const text = String(asset?.min_trade_increment || asset?.min_order_size || "0.00000001");
  const decimals = text.includes(".") ? text.split(".")[1].replace(/0+$/, "").length || text.split(".")[1].length : 8;
  return Math.max(0, value).toFixed(Math.min(12, Math.max(0, decimals)));
}

async function placeCryptoBuy(env, candidate, notional, now) {
  return alpaca(env, "/v2/orders", { method: "POST", body: JSON.stringify({ symbol: candidate.symbol, notional: round(notional, 2).toFixed(2), side: "buy", type: "market", time_in_force: "gtc", client_order_id: cid("buy", candidate.symbol, now, candidate.s5?.pullback ? "pb" : "bo") }) });
}

async function placeCryptoSell(env, position, asset, signal, now, reason) {
  const symbol = signal?.symbol || asset?.symbol || position.symbol, qty = formatSellQty(Math.abs(+position.qty || 0), asset);
  if (!(+qty > 0)) throw new Error("crypto_exit_quantity_too_small");
  return alpaca(env, "/v2/orders", { method: "POST", body: JSON.stringify({ symbol, qty, side: "sell", type: "market", time_in_force: "gtc", client_order_id: cid("sell", symbol, now, reason.slice(0,8)) }) });
}

function positionNotional(equity, candidate, env, learning) {
  const max = num(env.CRYPTO_MAX_POSITION_USD, 15000), cap = num(env.CRYPTO_ORDER_NOTIONAL_USD, 15000), risk = pct(env.CRYPTO_RISK_PER_TRADE_PCT, 0.0035), stop = exitParams(candidate, env).stop;
  const budget = equity * risk * learning.riskMultiplier, riskBased = stop ? budget / stop : max;
  const confidence = clamp((candidate.score - learning.scoreThreshold + 18) / 24, 0.7, 1);
  return clamp(Math.min(riskBased, max, cap) * confidence, num(env.CRYPTO_MIN_ORDER_NOTIONAL_USD, 25), max);
}

function recentCryptoCooldowns(orders, now, minutes) {
  const cut = +now - minutes * 60000, blocked = new Set();
  for (const o of orders) {
    if (o.side !== "sell" || o.status !== "filled" || !isCryptoOrder(o)) continue;
    const t = Date.parse(o.filled_at || 0);
    if (Number.isFinite(t) && t >= cut) blocked.add(norm(o.symbol));
  }
  return blocked;
}

export async function runCryptoCycle(env, scheduledTime) {
  if (!cryptoEnabled(env)) return { status: "disabled", strategy: CRYPTO_STRATEGY, endpoint: "paper", market: "24x7" };
  if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) throw new Error("missing_alpaca_secrets");

  const u = await cryptoUniverse(env), assets = u.assets.slice(0, int(env.CRYPTO_MAX_UNIVERSE_SYMBOLS, 30)), symbols = assets.map(a => a.symbol);
  if (!symbols.length) return { status: "no_crypto_assets", strategy: CRYPTO_STRATEGY, endpoint: "paper", market: "24x7" };

  const [snapshots, b1, b5, b15] = await Promise.all([
    cryptoSnapshots(env, symbols),
    cryptoBars(env, symbols, "1Min", 55),
    cryptoBars(env, symbols, "5Min", 80),
    cryptoBars(env, symbols, "15Min", 70)
  ]);
  const signals = symbols.map(symbol => {
    try {
      const snap = snapshots[symbol] || snapshots[norm(symbol)] || {};
      return combineSignals(symbol, timeframeSignal(symbol, b1[symbol]), timeframeSignal(symbol, b5[symbol]), timeframeSignal(symbol, b15[symbol]), snap);
    } catch (error) { console.log(JSON.stringify({ event: "crypto_signal_failed", symbol, message: error.message })); return { symbol, valid: false }; }
  }).filter(s => s.valid);
  const signalByNorm = new Map(signals.map(s => [norm(s.symbol), s])), regime = cryptoRegime(signals), assetByNorm = new Map(assets.map(a => [norm(a.symbol), a]));

  const [positions, openOrders, recentOrders, account] = await Promise.all([
    alpaca(env, "/v2/positions"),
    alpaca(env, "/v2/orders?status=open&direction=desc&nested=false"),
    alpaca(env, "/v2/orders?status=all&limit=500&direction=desc&nested=false"),
    alpaca(env, "/v2/account")
  ]);
  const lots = cryptoLots(recentOrders), cryptoOpen = new Set(openOrders.filter(isCryptoOrder).map(o => norm(o.symbol))), actions = [];
  const botPositions = positions.flatMap(p => {
    const key = norm(p.symbol), lot = lots[key];
    if (!lot || !(lot.qty > 1e-10)) return [];
    const actual = Math.abs(+p.qty || 0), qty = Math.min(actual, lot.qty), signal = signalByNorm.get(key);
    if (!(qty > 1e-10)) return [];
    return [{ ...p, qty: String(qty), avg_entry_price: String(lot.avgEntry || p.avg_entry_price), current_price: String(signal?.price || p.current_price), _key: key }];
  });

  for (const position of botPositions) {
    if (cryptoOpen.has(position._key)) continue;
    const signal = signalByNorm.get(position._key), decision = cryptoExitDecision(position, signal, env, regime);
    if (!decision.exit) continue;
    try {
      await placeCryptoSell(env, position, assetByNorm.get(position._key), signal, scheduledTime, decision.reason);
      actions.push({ action: "crypto_sell", symbol: signal?.symbol || position.symbol, reason: decision.reason, pnlPct: round(decision.pnlPct, 5), botQty: +position.qty });
      cryptoOpen.add(position._key);
    } catch (error) { console.log(JSON.stringify({ event: "crypto_exit_failed", symbol: position.symbol, reason: decision.reason, message: error.message })); }
  }

  const equity = Math.max(1, +account.equity || 1), perf = cryptoPerformance(recentOrders), learning = adaptiveLearning(perf, num(env.CRYPTO_MIN_ENTRY_SCORE, 82));
  const todayKey = etDateKey(scheduledTime), dayTrades = perf.tradeEvents.filter(t => t.at && etDateKey(t.at) === todayKey), dailyPnl = dayTrades.reduce((a,t) => a + t.pnl, 0), dailyLosses = dayTrades.filter(t => t.pnl < 0).length;
  let consec = 0, maxConsec = 0; for (const t of dayTrades) { if (t.pnl < 0) { consec++; maxConsec = Math.max(maxConsec, consec); } else if (t.pnl > 0) consec = 0; }
  const dailyLossGuard = dailyPnl <= -(equity * pct(env.CRYPTO_MAX_DAILY_LOSS_PCT, 0.0125)), lossCountGuard = dailyLosses >= int(env.CRYPTO_MAX_DAILY_LOSING_EXITS, 4), consecutiveLossGuard = maxConsec >= int(env.CRYPTO_MAX_CONSECUTIVE_LOSSES, 3);
  const cooldowns = recentCryptoCooldowns(recentOrders, scheduledTime, int(env.CRYPTO_SYMBOL_COOLDOWN_MINUTES, 10));

  const maxSpread = pct(env.CRYPTO_MAX_SPREAD_PCT, 0.004), maxAge = int(env.CRYPTO_MAX_QUOTE_AGE_SECONDS, 20), minDollarVolume = num(env.CRYPTO_MIN_DOLLAR_VOLUME_USD, 1000000), minQuoteUsd = num(env.CRYPTO_MIN_QUOTE_NOTIONAL_USD, 1000);
  const occupied = new Set(botPositions.map(p => p._key));
  const ranked = signals.filter(s => {
    const key = norm(s.symbol), bidNotional = s.bid * s.bidSize, askNotional = s.ask * s.askSize;
    return !occupied.has(key) && !cryptoOpen.has(key) && !cooldowns.has(key) && s.longConfirmed && !s.chop && s.price > 0 && s.dollarVolume >= minDollarVolume && bidNotional >= minQuoteUsd && askNotional >= minQuoteUsd && s.spreadPct <= maxSpread && s.quoteAgeSec <= maxAge;
  }).sort((a,b) => b.score - a.score);

  const maxPositions = int(env.CRYPTO_MAX_CONCURRENT_POSITIONS, 2), maxTotal = num(env.CRYPTO_MAX_TOTAL_EXPOSURE_USD, 30000), maxNew = int(env.CRYPTO_MAX_NEW_ENTRIES_PER_CYCLE, 1);
  const currentExposure = botPositions.reduce((a,p) => a + Math.abs((+p.qty || 0) * (+p.current_price || 0)), 0);
  let slots = Math.max(0, maxPositions - botPositions.length), remaining = Math.max(0, maxTotal - currentExposure), newEntries = 0;
  const cashLike = Math.max(0, +(account.non_marginable_buying_power || account.cash || account.buying_power || 0));
  const threshold = requiredScore(regime, learning, env), canRisk = !dailyLossGuard && !lossCountGuard && !consecutiveLossGuard && !regime.shock;

  for (const candidate of ranked) {
    if (!canRisk || slots <= 0 || remaining < 1 || newEntries >= maxNew) break;
    if (candidate.score < threshold) continue;
    const notional = Math.min(positionNotional(equity, candidate, env, learning), remaining, cashLike);
    if (notional < num(env.CRYPTO_MIN_ORDER_NOTIONAL_USD, 25)) continue;
    try {
      await placeCryptoBuy(env, candidate, notional, scheduledTime);
      actions.push({ action: "crypto_buy", symbol: candidate.symbol, reason: "ranked_edge", score: round(candidate.score, 1), threshold: round(threshold, 1), regime: regime.mode, spreadPct: round(candidate.spreadPct, 5), notional: round(notional, 2) });
      slots--; remaining -= notional; newEntries++;
    } catch (error) { console.log(JSON.stringify({ event: "crypto_entry_failed", symbol: candidate.symbol, message: error.message })); }
  }

  const result = { status: actions.length ? "acted" : "hold", strategy: CRYPTO_STRATEGY, endpoint: "paper", market: "24x7", universeSource: u.source, universeCount: symbols.length, regime, learning, daily: { pnl: round(dailyPnl, 2), losses: dailyLosses, maxConsecLoss: maxConsec }, risk: { exposure: round(currentExposure, 2), maxExposure: maxTotal, dailyLossGuard, lossCountGuard, consecutiveLossGuard }, actions, leaders: ranked.slice(0,8).map(s => ({ symbol: s.symbol, score: round(s.score,1), spreadPct: round(s.spreadPct,5), rvol: round(s.rvol,2), dollarVolume: round(s.dollarVolume,0) })) };
  console.log(JSON.stringify({ event: "crypto_cycle_complete", ...result }));
  return result;
}

export async function cryptoStatus(env) {
  const u = await cryptoUniverse(env), symbols = u.assets.slice(0, 5).map(a => a.symbol);
  let marketDataReachable = false;
  try { if (symbols.length) { await cryptoSnapshots(env, symbols); marketDataReachable = true; } } catch {}
  let account = {};
  try { account = await alpaca(env, "/v2/account"); } catch {}
  return { strategy: CRYPTO_STRATEGY, enabled: cryptoEnabled(env), endpoint: "paper", market: "24x7", universeSource: u.source, universeCount: u.assets.length, sampleSymbols: symbols, marketDataReachable, cryptoAccountStatus: account.crypto_status || null, maxConcurrentPositions: int(env.CRYPTO_MAX_CONCURRENT_POSITIONS, 2), maxTotalExposureUsd: num(env.CRYPTO_MAX_TOTAL_EXPOSURE_USD, 30000), minEntryScore: num(env.CRYPTO_MIN_ENTRY_SCORE, 82), targetRMultiple: num(env.CRYPTO_TARGET_R_MULTIPLE, 2.4), symbolCooldownMinutes: int(env.CRYPTO_SYMBOL_COOLDOWN_MINUTES, 10) };
}

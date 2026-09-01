import { bool, isBotOrder, num, pct, int, entryWindowOpen } from "./config.js";
import { alpaca, dynamicUniverse, fetchSnapshots, fetchBars } from "./api.js";
import { timeframeSignal, combineSignals, marketRegime } from "./signals.js";

function stub(env) {
  if (!env.TRADING_STATE) return null;
  try { return env.TRADING_STATE.getByName("primary"); }
  catch {
    try {
      const id = env.TRADING_STATE.idFromName("primary");
      return env.TRADING_STATE.get(id);
    } catch { return null; }
  }
}

async function call(env, path, init = {}) {
  const s = stub(env);
  if (!s) return null;
  try {
    const r = await s.fetch(`https://state.internal${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) }
    });
    if (!r.ok) return null;
    return r.json();
  } catch (error) {
    console.log(JSON.stringify({ event: "state_degraded", path, message: error.message }));
    return null;
  }
}

export async function ensureRealtimeState(env, symbols, feed) {
  if (!bool(env.REALTIME_STREAM_ENABLED, true)) return null;
  return call(env, "/ensure", { method: "POST", body: JSON.stringify({ symbols, feed }) });
}

export async function getRealtimeMarket(env) {
  if (!bool(env.REALTIME_STREAM_ENABLED, true)) return {};
  const r = await call(env, "/market");
  return r?.market || {};
}

export function overlayRealtimeSnapshot(snapshot, live) {
  if (!live) return snapshot || {};
  const out = { ...(snapshot || {}) };
  if (live.quote) out.latestQuote = live.quote;
  if (live.trade) out.latestTrade = live.trade;
  if (live.bar) out.minuteBar = live.bar;
  out.realtimeStatus = live.status || null;
  out.realtimeLuld = live.luld || null;
  out.realtimeHalted = Boolean(live.halted);
  out.realtimeReceivedAt = live.receivedAt || 0;
  return out;
}

export async function updateHighWater(env, equity) {
  if (!bool(env.PERSISTENT_STATE_ENABLED, true)) return null;
  return call(env, "/equity", { method: "POST", body: JSON.stringify({ equity }) });
}

export async function persistJournal(env, journal) {
  if (!bool(env.PERSISTENT_STATE_ENABLED, true)) return null;
  return call(env, "/journal", { method: "POST", body: JSON.stringify(journal) });
}

async function opportunityDiagnostics(env, positions) {
  const symbols = await dynamicUniverse(env);
  const snap = await fetchSnapshots(env, symbols);
  const bundles = await Promise.all(symbols.map(async symbol => {
    try {
      const [m1, m5, m15] = await Promise.all([
        fetchBars(env, symbol, "1Min", 55),
        fetchBars(env, symbol, "5Min", 80),
        fetchBars(env, symbol, "15Min", 70)
      ]);
      return combineSignals(symbol, timeframeSignal(symbol, m1.bars), timeframeSignal(symbol, m5.bars), timeframeSignal(symbol, m15.bars), snap.snapshots[symbol]);
    } catch (error) {
      return { symbol, valid: false, error: String(error?.message || error).slice(0, 120) };
    }
  }));
  const signals = bundles.filter(s => s.valid);
  const map = new Map(signals.map(s => [s.symbol, s]));
  const regime = marketRegime(map);
  const occupied = new Set((positions || []).map(p => p.symbol));
  const maxSpread = pct(env.MAX_SPREAD_PCT, 0.0015);
  const maxAge = int(env.MAX_QUOTE_AGE_SECONDS, 20);
  const minDollarVolume = num(env.MIN_DOLLAR_VOLUME_USD, 50_000_000);
  const minQuoteSize = num(env.MIN_QUOTE_SIZE, 1);
  const minPrice = num(env.MIN_PRICE_USD, 5);
  const ranked = signals.filter(s =>
    !occupied.has(s.symbol) && !s.halted && !s.nearLuld &&
    s.price >= minPrice && s.dollarVolume >= minDollarVolume &&
    s.bidSize >= minQuoteSize && s.askSize >= minQuoteSize &&
    s.spreadPct <= maxSpread && s.quoteAgeSec <= maxAge && !s.chop
  ).sort((a, b) => b.score - a.score);
  return {
    universeCount: symbols.length,
    validSignals: signals.length,
    rankedCount: ranked.length,
    entryWindowOpen: entryWindowOpen(Date.now()),
    minEntryScore: num(env.MIN_ENTRY_SCORE, 82),
    regime,
    topCandidates: ranked.slice(0, 10).map(s => ({
      symbol: s.symbol,
      score: Number(s.score.toFixed(1)),
      longConfirmed: Boolean(s.longConfirmed),
      longAligned: Boolean(s.longAligned),
      price: Number((s.price || 0).toFixed(4)),
      spreadPct: Number((s.spreadPct || 0).toFixed(5)),
      quoteAgeSec: Number((s.quoteAgeSec || 0).toFixed(1)),
      dollarVolume: Math.round(s.dollarVolume || 0),
      rvol: Number((s.rvol || 0).toFixed(2)),
      rsi: Number((s.rsi || 0).toFixed(1)),
      chop: Boolean(s.chop)
    }))
  };
}

async function directAlpacaHealth(env) {
  const [account, positions, orders] = await Promise.all([
    alpaca(env, "/v2/account"),
    alpaca(env, "/v2/positions"),
    alpaca(env, "/v2/orders?status=all&limit=200&direction=desc&nested=false")
  ]);
  const botOrders = (orders || []).filter(isBotOrder);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const etDate = value => {
    if (!value) return "";
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
    catch { return ""; }
  };
  const botOrdersToday = botOrders.filter(o => etDate(o.submitted_at || o.created_at) === today);
  let diagnostics = null;
  try { diagnostics = await opportunityDiagnostics(env, positions); }
  catch (error) { diagnostics = { error: String(error?.message || error).slice(0, 300) }; }
  return {
    mode: "direct_alpaca_rest",
    connected: false,
    persistentState: false,
    realtimeStreamDisabled: true,
    equity: Number(account?.equity || 0),
    lastEquity: Number(account?.last_equity || 0),
    buyingPower: Number(account?.buying_power || 0),
    positions: Array.isArray(positions) ? positions.length : 0,
    positionSummary: (positions || []).slice(0, 12).map(p => ({ symbol: p.symbol, qty: Number(p.qty || 0), marketValue: Number(p.market_value || 0), unrealizedPl: Number(p.unrealized_pl || 0), unrealizedPlpc: Number(p.unrealized_plpc || 0) })),
    botOrdersToday: botOrdersToday.length,
    lastBotOrderAt: botOrders[0]?.submitted_at || botOrders[0]?.created_at || null,
    recentBotOrders: botOrders.slice(0, 8).map(o => ({
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      status: o.status,
      submittedAt: o.submitted_at || o.created_at || null,
      filledAt: o.filled_at || null,
      filledAvgPrice: o.filled_avg_price ? Number(o.filled_avg_price) : null,
      filledQty: o.filled_qty ? Number(o.filled_qty) : null,
      limitPrice: o.limit_price ? Number(o.limit_price) : null
    })),
    diagnostics
  };
}

export async function stateHealth(env) {
  if (!bool(env.REALTIME_STREAM_ENABLED, true) && !bool(env.PERSISTENT_STATE_ENABLED, true)) {
    try { return await directAlpacaHealth(env); }
    catch (error) { return { mode: "direct_alpaca_rest", connected: false, persistentState: false, realtimeStreamDisabled: true, stateError: String(error?.message || error).slice(0, 500) }; }
  }
  if (!env.TRADING_STATE) return { connected: false, persistentState: false, stateError: "missing_TRADING_STATE_binding" };
  const s = stub(env);
  if (!s) return { connected: false, persistentState: false, stateError: "unable_to_create_TRADING_STATE_stub" };
  try {
    const r = await s.fetch("https://state.internal/health", { headers: { "Content-Type": "application/json" } });
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 300); } catch {}
      return { connected: false, persistentState: false, stateError: `state_http_${r.status}`, stateDetail: detail };
    }
    return await r.json();
  } catch (error) {
    return { connected: false, persistentState: false, stateError: String(error?.message || error).slice(0, 500) };
  }
}

import { bool, isBotOrder } from "./config.js";
import { alpaca } from "./api.js";

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
  return {
    mode: "direct_alpaca_rest",
    connected: false,
    persistentState: false,
    realtimeStreamDisabled: true,
    equity: Number(account?.equity || 0),
    lastEquity: Number(account?.last_equity || 0),
    buyingPower: Number(account?.buying_power || 0),
    positions: Array.isArray(positions) ? positions.length : 0,
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
    }))
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

import { bool } from "./config.js";

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

export async function stateHealth(env) {
  const [health, journal] = await Promise.all([call(env, "/health"), call(env, "/journal")]);
  if (!health) return null;
  const journals = Array.isArray(journal?.journals) ? journal.journals : [];
  const recent = journals.slice(-5).map(j => ({
    ts: j.ts,
    status: Array.isArray(j.actions) && j.actions.length ? "acted" : "hold",
    actions: j.actions || [],
    daily: j.daily || null,
    risk: j.risk || null,
    regime: j.regime || null,
    learning: j.learning || null,
    leaders: (j.leaders || []).slice(0, 5),
    universeCount: Array.isArray(j.universe) ? j.universe.length : 0,
    discordConfigured: Boolean(j.externalSignals?.discordConfigured)
  }));
  return { ...health, recentCycles: recent };
}

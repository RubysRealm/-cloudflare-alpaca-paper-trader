import { alpaca, fetchLatestQuote } from "./api.js";
import { pct, int, num, clamp, isBotOrder } from "./config.js";

export function dynamicExitParams(signal, env, side = "long") {
  const a = signal?.atrPct || 0.004, base = pct(env.STOP_LOSS_PCT, 0.0045), min = pct(env.MIN_STOP_LOSS_PCT, 0.003), max = pct(env.MAX_STOP_LOSS_PCT, 0.009);
  const stop = clamp(Math.max(base, a * 0.85), min, max), rr = num(env.TARGET_R_MULTIPLE, 1.8), target = clamp(stop * rr, 0.0055, 0.02);
  return { side, stop, target, trailTrigger: clamp(stop * 0.85, 0.0035, 0.012), trailGiveback: clamp(stop * 0.38, 0.0015, 0.005) };
}

export function exitDecision(position, signal, env, now, etParts) {
  const entry = +position.avg_entry_price, price = signal?.price || +position.current_price, side = +position.qty < 0 ? "short" : "long", p = dynamicExitParams(signal, env, side);
  const pnl = entry > 0 ? (side === "long" ? price / entry - 1 : entry / price - 1) : 0;
  if (pnl <= -p.stop) return { exit: true, reason: "dynamic_stop", pnlPct: pnl };
  if (pnl >= p.target) return { exit: true, reason: "dynamic_target", pnlPct: pnl };
  if (pnl >= p.trailTrigger && signal) {
    const fail = side === "long" ? price < signal.s5.ema9 * (1 - p.trailGiveback) : price > signal.s5.ema9 * (1 + p.trailGiveback);
    if (fail) return { exit: true, reason: "adaptive_trail", pnlPct: pnl };
  }
  if (pnl >= Math.max(0.002, p.stop * 0.45) && signal) {
    const fail = side === "long" ? !signal.s5.trendSlope || price < signal.s5.ema9 : !signal.s5.downSlope || price > signal.s5.ema9;
    if (fail) return { exit: true, reason: "profit_protect", pnlPct: pnl };
  }
  if (signal) {
    const fail = side === "long" ? (!signal.s5.trend || price < signal.s5.vwap) : (!signal.s5.downTrend || price > signal.s5.vwap);
    if (fail) return { exit: true, reason: "trend_failure", pnlPct: pnl };
  }
  const { hour, minute } = etParts(now);
  if (hour > 15 || (hour === 15 && minute >= 55)) return { exit: true, reason: "end_of_day_flatten", pnlPct: pnl };
  return { exit: false, reason: "hold", pnlPct: pnl };
}

const cid = (prefix, symbol, time, tag = "") => `${prefix}-${tag}-${symbol}-${Number(time).toString(36)}`.replace(/--+/g, "-").slice(0, 48);

async function freshQuote(env, symbol) {
  const { quote } = await fetchLatestQuote(env, symbol);
  const bid = +(quote?.bp || quote?.bid_price || 0), ask = +(quote?.ap || quote?.ask_price || 0), bidSize = +(quote?.bs || quote?.bid_size || 0), askSize = +(quote?.as || quote?.ask_size || 0);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
  const spreadPct = mid > 0 && ask >= bid ? (ask - bid) / mid : 1;
  const ts = Date.parse(quote?.t || quote?.timestamp || 0);
  const quoteAgeSec = Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / 1000) : 9999;
  return { bid, ask, bidSize, askSize, mid, spreadPct, quoteAgeSec };
}

export async function cancelStaleBotOrders(env, orders, now) {
  const age = int(env.ORDER_TIMEOUT_SECONDS, 75) * 1000, actions = [];
  for (const o of orders.filter(isBotOrder)) {
    const t = Date.parse(o.submitted_at || o.created_at || 0);
    if (Number.isFinite(t) && +now - t > age) {
      try { await alpaca(env, `/v2/orders/${o.id}`, { method: "DELETE" }); actions.push({ action: "cancel", symbol: o.symbol, reason: "stale_limit" }); }
      catch (e) { console.log(JSON.stringify({ event: "cancel_failed", id: o.id, message: e.message })); }
    }
  }
  return actions;
}

export async function placeLimitBuy(env, c, notional, now) {
  const q = await freshQuote(env, c.symbol);
  const maxSpread = pct(env.MAX_SPREAD_PCT, 0.0015), maxAge = int(env.MAX_QUOTE_AGE_SECONDS, 20), minQuoteSize = num(env.MIN_QUOTE_SIZE, 1);
  if (!(q.bid > 0 && q.ask > 0)) throw new Error("fresh_quote_unavailable");
  if (q.quoteAgeSec > maxAge) throw new Error("fresh_quote_stale");
  if (q.spreadPct > maxSpread) throw new Error("fresh_spread_too_wide");
  if (q.bidSize < minQuoteSize || q.askSize < minQuoteSize) throw new Error("fresh_quote_size_too_small");

  const slip = pct(env.MAX_ENTRY_SLIPPAGE_PCT, 0.0008), limit = q.ask * (1 + slip);
  const qty = Math.floor((notional / limit) * 1e8) / 1e8;
  if (!(qty > 0)) throw new Error("entry_quantity_too_small");
  return alpaca(env, "/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol: c.symbol, qty: qty.toFixed(8), side: "buy", type: "limit", limit_price: limit.toFixed(2), time_in_force: "day",
      client_order_id: cid("paper8-buy", c.symbol, now, c.s5.pullback ? "pb" : "bo")
    })
  });
}

export async function placeLimitSell(env, p, s, now, reason) {
  let q = null;
  try { q = await freshQuote(env, p.symbol); } catch {}
  const slip = pct(env.MAX_EXIT_SLIPPAGE_PCT, 0.0012), ref = q?.bid > 0 ? q.bid : s?.bid > 0 ? s.bid : +p.current_price, limit = ref * (1 - slip);
  const qty = Math.abs(+p.qty || 0);
  if (!(qty > 0)) throw new Error("exit_quantity_too_small");
  return alpaca(env, "/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol: p.symbol, qty: qty.toFixed(8), side: "sell", type: "limit", limit_price: Math.max(0.01, limit).toFixed(2), time_in_force: "day",
      client_order_id: cid("paper8-sell", p.symbol, now, reason.slice(0, 8))
    })
  });
}

export function positionNotional(equity, c, env, learning, drawdownMultiplier) {
  const max = num(env.MAX_POSITION_USD, 5), cap = num(env.ORDER_NOTIONAL_USD, 5), risk = pct(env.RISK_PER_TRADE_PCT, 0.00025), stop = dynamicExitParams(c, env).stop;
  const budget = equity * risk * learning.riskMultiplier * drawdownMultiplier, riskBased = stop ? budget / stop : max;
  const confidence = clamp((c.score - learning.scoreThreshold + 12) / 24, 0.35, 1);
  return clamp(Math.min(riskBased, max, cap) * confidence, 1, max);
}
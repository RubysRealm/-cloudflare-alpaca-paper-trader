import { alpaca, fetchLatestQuote } from "./api.js";
import { pct, int, num, clamp, isBotOrder } from "./config.js";

export function dynamicExitParams(signal, env, side = "long") {
  const a = signal?.atrPct || 0.004, base = pct(env.STOP_LOSS_PCT, 0.0045), min = pct(env.MIN_STOP_LOSS_PCT, 0.003), max = pct(env.MAX_STOP_LOSS_PCT, 0.008);
  const stop = clamp(Math.max(base, a * 0.85), min, max), rr = num(env.TARGET_R_MULTIPLE, 2.4), target = clamp(stop * rr, 0.009, 0.026);
  return { side, stop, target, trailTrigger: clamp(Math.max(stop * 1.15, target * 0.55), 0.0055, 0.016), trailGiveback: clamp(stop * 0.5, 0.002, 0.006) };
}

export function exitDecision(position, signal, env, now, etParts) {
  const entry = +position.avg_entry_price, price = signal?.price || +position.current_price, side = +position.qty < 0 ? "short" : "long", p = dynamicExitParams(signal, env, side);
  const pnl = entry > 0 ? (side === "long" ? price / entry - 1 : entry / price - 1) : 0;
  const scoreFloor = num(env.MIN_ENTRY_SCORE, 82);

  if (pnl <= -p.stop) return { exit: true, reason: "dynamic_stop", pnlPct: pnl };

  if (signal && pnl <= -0.0015) {
    const thesisBroken = side === "long"
      ? (!signal.longConfirmed || signal.score < scoreFloor * 0.85 || (signal.s1?.ret1 < 0 && signal.s5?.ret1 < 0))
      : (!signal.shortConfirmed || signal.shortScore < scoreFloor * 0.85 || (signal.s1?.ret1 > 0 && signal.s5?.ret1 > 0));
    if (thesisBroken) return { exit: true, reason: "thesis_failed", pnlPct: pnl };
  }

  if (pnl >= p.target) return { exit: true, reason: "dynamic_target", pnlPct: pnl };

  if (pnl >= p.trailTrigger && signal) {
    const fail = side === "long" ? price < signal.s5.ema9 * (1 - p.trailGiveback) : price > signal.s5.ema9 * (1 + p.trailGiveback);
    if (fail) return { exit: true, reason: "adaptive_trail", pnlPct: pnl };
  }

  const protectAt = Math.max(0.0045, p.stop * 0.8);
  if (pnl >= protectAt && signal) {
    const fail = side === "long"
      ? ((!signal.longConfirmed || signal.score < scoreFloor) && price < signal.s5.ema9)
      : ((!signal.shortConfirmed || signal.shortScore < scoreFloor) && price > signal.s5.ema9);
    if (fail) return { exit: true, reason: "profit_protect", pnlPct: pnl };
  }

  if (signal && pnl <= -Math.max(0.002, p.stop * 0.45)) {
    const fail = side === "long"
      ? ((!signal.s5.trend && !signal.s15.trend) || (price < signal.s5.vwap && price < signal.s15.vwap))
      : ((!signal.s5.downTrend && !signal.s15.downTrend) || (price > signal.s5.vwap && price > signal.s15.vwap));
    if (fail) return { exit: true, reason: "trend_failure", pnlPct: pnl };
  }

  const { hour, minute } = etParts(now);
  if (hour > 15 || (hour === 15 && minute >= 50)) return { exit: true, reason: "end_of_day_flatten", pnlPct: pnl };
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
  const maxSpread = pct(env.MAX_SPREAD_PCT, 0.003), maxAge = int(env.MAX_QUOTE_AGE_SECONDS, 20), minQuoteSize = num(env.MIN_QUOTE_SIZE, 1);
  if (!(q.bid > 0 && q.ask > 0)) throw new Error("fresh_quote_unavailable");
  if (q.quoteAgeSec > maxAge) throw new Error("fresh_quote_stale");
  if (q.spreadPct > maxSpread) throw new Error("fresh_spread_too_wide");
  if (q.bidSize < minQuoteSize || q.askSize < minQuoteSize) throw new Error("fresh_quote_size_too_small");
  const slip = pct(env.MAX_ENTRY_SLIPPAGE_PCT, 0.001), limit = q.ask * (1 + slip), qty = Math.floor((notional / limit) * 1e8) / 1e8;
  if (!(qty > 0)) throw new Error("entry_quantity_too_small");
  return alpaca(env, "/v2/orders", { method: "POST", body: JSON.stringify({ symbol: c.symbol, qty: qty.toFixed(8), side: "buy", type: "limit", limit_price: limit.toFixed(2), time_in_force: "day", client_order_id: cid("paper8-buy", c.symbol, now, c.s5.pullback ? "pb" : "bo") }) });
}

export async function placeLimitSell(env, p, s, now, reason) {
  const qty = Math.abs(+p.qty || 0);
  if (!(qty > 0)) throw new Error("exit_quantity_too_small");
  if (reason === "end_of_day_flatten") {
    return alpaca(env, "/v2/orders", { method: "POST", body: JSON.stringify({ symbol: p.symbol, qty: qty.toFixed(8), side: "sell", type: "market", time_in_force: "day", client_order_id: cid("paper8-sell", p.symbol, now, "eodflat") }) });
  }
  let q = null; try { q = await freshQuote(env, p.symbol); } catch {}
  const slip = pct(env.MAX_EXIT_SLIPPAGE_PCT, 0.0012), ref = q?.bid > 0 ? q.bid : s?.bid > 0 ? s.bid : +p.current_price, limit = ref * (1 - slip);
  return alpaca(env, "/v2/orders", { method: "POST", body: JSON.stringify({ symbol: p.symbol, qty: qty.toFixed(8), side: "sell", type: "limit", limit_price: Math.max(0.01, limit).toFixed(2), time_in_force: "day", client_order_id: cid("paper8-sell", p.symbol, now, reason.slice(0, 8)) }) });
}

export function positionNotional(equity, c, env, learning, drawdownMultiplier) {
  const max = num(env.MAX_POSITION_USD, 25000), cap = num(env.ORDER_NOTIONAL_USD, 25000), risk = pct(env.RISK_PER_TRADE_PCT, 0.0035), stop = dynamicExitParams(c, env).stop;
  const budget = equity * risk * learning.riskMultiplier * drawdownMultiplier, riskBased = stop ? budget / stop : max;
  const confidence = clamp((c.score - learning.scoreThreshold + 18) / 24, 0.7, 1);
  return clamp(Math.min(riskBased, max, cap) * confidence, 1, max);
}

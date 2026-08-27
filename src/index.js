var PAPER_API = "https://paper-api.alpaca.markets";
var DATA_API = "https://data.alpaca.markets";

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function pct(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}
function int(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}
function headers(env) {
  return {
    "APCA-API-KEY-ID": env.APCA_API_KEY_ID,
    "APCA-API-SECRET-KEY": env.APCA_API_SECRET_KEY,
    "Content-Type": "application/json"
  };
}
async function alpaca(env, path, init) {
  const response = await fetch(`${PAPER_API}${path}`, { ...init, headers: { ...headers(env), ...init?.headers } });
  if (!response.ok) throw new Error(`alpaca_${response.status}_${path.split("?")[0]}`);
  return response.json();
}
async function marketData(env, path) {
  const response = await fetch(`${DATA_API}${path}`, { headers: headers(env) });
  if (!response.ok) throw new Error(`market_data_${response.status}_${path.split("?")[0]}`);
  return response.json();
}
function universe(env) {
  const raw = String(env.SYMBOLS || env.SYMBOL || "SPY,QQQ,IWM,NVDA,AAPL,TSLA,AMD,AMZN,META,MSFT");
  return [...new Set(raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))].slice(0, 20);
}
function ema(values, period) {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}
function average(values) {
  return values.length ? values.reduce((a,b)=>a+b,0) / values.length : 0;
}
function stddev(values) {
  if (values.length < 2) return 0;
  const m = average(values);
  return Math.sqrt(average(values.map(v => (v-m)*(v-m))));
}
function barsToSignal(symbol, bars) {
  const clean = (bars || []).filter(b => Number.isFinite(Number(b.c)) && Number.isFinite(Number(b.v)));
  if (clean.length < 24) return { symbol, valid:false, reason:"insufficient_bars" };
  const closes = clean.map(b => Number(b.c));
  const highs = clean.map(b => Number(b.h));
  const lows = clean.map(b => Number(b.l));
  const volumes = clean.map(b => Number(b.v));
  const price = closes.at(-1);
  const ema9 = ema(closes.slice(-30), 9);
  const ema21 = ema(closes.slice(-40), 21);
  const rsi14 = rsi(closes, 14);
  const avgVol20 = average(volumes.slice(-21, -1));
  const relVolume = avgVol20 > 0 ? volumes.at(-1) / avgVol20 : 0;
  const high20 = Math.max(...highs.slice(-21, -1));
  const low20 = Math.min(...lows.slice(-21, -1));
  const ret1 = closes.length > 1 ? price / closes.at(-2) - 1 : 0;
  const ret3 = closes.length > 3 ? price / closes.at(-4) - 1 : 0;
  const ret6 = closes.length > 6 ? price / closes.at(-7) - 1 : 0;
  const returns = closes.slice(-21).slice(1).map((c,i) => c / closes.slice(-21)[i] - 1);
  const vol = stddev(returns);
  let cumulativePV = 0, cumulativeV = 0;
  for (const b of clean) {
    const typical = (Number(b.h)+Number(b.l)+Number(b.c))/3;
    const v = Number(b.v);
    cumulativePV += typical * v;
    cumulativeV += v;
  }
  const vwap = cumulativeV ? cumulativePV / cumulativeV : price;
  const aboveVwap = price > vwap;
  const trend = ema9 > ema21;
  const breakout = price >= high20 * 0.9995;
  const pullback = trend && aboveVwap && price > ema9 * 0.998 && price < ema9 * 1.004;
  const momentum = ret3 > 0.001 && ret6 > 0.0015;
  const healthyRsi = rsi14 >= 52 && rsi14 <= 78;
  let score = 0;
  if (trend) score += 22;
  if (aboveVwap) score += 18;
  if (breakout) score += 22;
  if (pullback) score += 12;
  if (momentum) score += 14;
  if (healthyRsi) score += 8;
  score += Math.min(14, Math.max(0, (relVolume - 1) * 10));
  score += Math.min(8, Math.max(0, ret1 * 1000));
  if (rsi14 > 84) score -= 15;
  if (ret1 < -0.0025) score -= 12;
  return {
    symbol, valid:true, price, ema9, ema21, vwap, rsi14, relVolume, high20, low20,
    ret1, ret3, ret6, volatility:vol, breakout, pullback, momentum, score
  };
}
function entryReason(s) {
  if (s.breakout && s.momentum) return "breakout_momentum";
  if (s.pullback) return "trend_pullback";
  return "ranked_momentum";
}
function exitDecision(position, signal, env, now) {
  const entry = Number(position.avg_entry_price);
  const price = signal?.price || Number(position.current_price);
  const stopLoss = pct(env.STOP_LOSS_PCT, 0.006);
  const takeProfit = pct(env.TAKE_PROFIT_PCT, 0.018);
  const trailTrigger = pct(env.TRAIL_TRIGGER_PCT, 0.009);
  const trailGiveback = pct(env.TRAIL_GIVEBACK_PCT, 0.0045);
  const pnlPct = entry > 0 ? price / entry - 1 : 0;
  if (pnlPct <= -stopLoss) return { exit:true, reason:"stop_loss", pnlPct };
  if (pnlPct >= takeProfit) return { exit:true, reason:"take_profit", pnlPct };
  if (pnlPct >= trailTrigger && signal && price < signal.ema9 * (1 - trailGiveback)) return { exit:true, reason:"trailing_exit", pnlPct };
  if (signal && signal.ema9 < signal.ema21 && price < signal.vwap) return { exit:true, reason:"trend_failure", pnlPct };
  const et = new Date(now).toLocaleString("en-US", {timeZone:"America/New_York", hour12:false, hour:"2-digit", minute:"2-digit"});
  const [hh,mm] = et.split(":").map(Number);
  if (hh > 15 || (hh === 15 && mm >= 55)) return { exit:true, reason:"end_of_day_flatten", pnlPct };
  return { exit:false, reason:"hold", pnlPct };
}
function clientId(prefix, symbol, time) {
  return `${prefix}-${symbol}-${Number(time).toString(36)}`.slice(0,48);
}
async function placeMarketBuy(env, symbol, notional, scheduledTime) {
  return alpaca(env, "/v2/orders", { method:"POST", body:JSON.stringify({
    symbol, notional:notional.toFixed(2), side:"buy", type:"market", time_in_force:"day",
    client_order_id:clientId("paper", symbol, scheduledTime)
  })});
}
async function placeMarketSell(env, position, scheduledTime, reason) {
  return alpaca(env, "/v2/orders", { method:"POST", body:JSON.stringify({
    symbol:position.symbol, qty:position.qty, side:"sell", type:"market", time_in_force:"day",
    client_order_id:clientId(`paper-${reason}`.slice(0,18), position.symbol, scheduledTime)
  })});
}
async function runCycle(env, scheduledTime) {
  if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) throw new Error("missing_alpaca_secrets");
  if (String(env.TRADING_ENABLED) !== "true") return {status:"disabled", endpoint:"paper"};
  const clock = await alpaca(env, "/v2/clock");
  if (!clock.is_open) return {status:"market_closed", endpoint:"paper"};

  const symbols = universe(env);
  const barLimit = 60;
  const data = await marketData(env, `/v2/stocks/bars?symbols=${encodeURIComponent(symbols.join(","))}&timeframe=5Min&limit=${barLimit}&feed=iex&adjustment=raw`);
  const signals = symbols.map(s => barsToSignal(s, data.bars?.[s] || [])).filter(s => s.valid);
  const signalMap = Object.fromEntries(signals.map(s => [s.symbol, s]));
  const [positions, openOrders, account] = await Promise.all([
    alpaca(env, "/v2/positions"),
    alpaca(env, "/v2/orders?status=open&direction=desc&nested=false"),
    alpaca(env, "/v2/account")
  ]);
  const botOpenSymbols = new Set(openOrders.filter(o => String(o.client_order_id||"").startsWith("paper-")).map(o => o.symbol));
  const botPositions = positions.filter(p => symbols.includes(p.symbol));
  const actions = [];

  for (const position of botPositions) {
    if (botOpenSymbols.has(position.symbol)) continue;
    const decision = exitDecision(position, signalMap[position.symbol], env, scheduledTime);
    if (decision.exit) {
      await placeMarketSell(env, position, scheduledTime, decision.reason);
      actions.push({action:"sell", symbol:position.symbol, reason:decision.reason, pnlPct:decision.pnlPct});
      botOpenSymbols.add(position.symbol);
    }
  }

  const minScore = num(env.MIN_ENTRY_SCORE, 65);
  const maxPositions = int(env.MAX_CONCURRENT_POSITIONS, 3);
  const orderNotional = num(env.ORDER_NOTIONAL_USD, 5);
  const maxPosition = num(env.MAX_POSITION_USD, orderNotional);
  const maxTotalExposure = num(env.MAX_TOTAL_EXPOSURE_USD, Math.max(maxPosition, orderNotional * maxPositions));
  const currentExposure = botPositions.reduce((sum,p)=>sum + Math.abs(Number(p.market_value)||0),0);
  const occupied = new Set(botPositions.map(p=>p.symbol));
  let slots = Math.max(0, maxPositions - botPositions.length);
  let remainingExposure = Math.max(0, maxTotalExposure - currentExposure);
  const buyingPower = Math.max(0, Number(account.buying_power)||0);

  const candidates = signals
    .filter(s => !occupied.has(s.symbol) && !botOpenSymbols.has(s.symbol) && s.score >= minScore)
    .sort((a,b)=>b.score-a.score);

  for (const candidate of candidates) {
    if (slots <= 0 || remainingExposure < 1) break;
    const notional = Math.min(orderNotional, maxPosition, remainingExposure, buyingPower);
    if (notional < 1) break;
    await placeMarketBuy(env, candidate.symbol, notional, scheduledTime);
    actions.push({action:"buy", symbol:candidate.symbol, reason:entryReason(candidate), score:Number(candidate.score.toFixed(1)), price:candidate.price});
    slots -= 1;
    remainingExposure -= notional;
    botOpenSymbols.add(candidate.symbol);
  }

  return {
    status: actions.length ? "acted" : "hold",
    endpoint:"paper",
    universe:symbols,
    scanned:signals.length,
    qualified:candidates.length,
    actions,
    leaders:signals.sort((a,b)=>b.score-a.score).slice(0,5).map(s=>({symbol:s.symbol,score:Number(s.score.toFixed(1)),price:s.price,rvol:Number(s.relVolume.toFixed(2)),rsi:Number(s.rsi14.toFixed(1))}))
  };
}
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function money(value) { return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(value)||0); }
function percentage(value) { return `${((Number(value)||0)*100).toFixed(2)}%`; }
async function digest(value) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
async function secureEqual(left,right) {
  const [a,b]=await Promise.all([digest(left),digest(right)]); if(a.length!==b.length)return false; let d=0; for(let i=0;i<a.length;i++)d|=a[i]^b[i]; return d===0;
}
async function isDashboardAuthorized(request, env) {
  if (!env.DASHBOARD_PASSWORD) return false;
  const auth=request.headers.get("Authorization"); if(!auth?.startsWith("Basic ")) return false;
  try { const decoded=atob(auth.slice(6)); const i=decoded.indexOf(":"); return i>=0 && secureEqual(decoded.slice(i+1),env.DASHBOARD_PASSWORD); } catch { return false; }
}
function calculatePerformance(orders) {
  const sorted=[...orders].filter(o=>o.filled_at&&o.filled_avg_price).sort((a,b)=>String(a.filled_at).localeCompare(String(b.filled_at)));
  const inventory={}; let realizedPnl=0,completedTrades=0,winningTrades=0;
  for(const o of sorted){ const q=Number(o.filled_qty),p=Number(o.filled_avg_price); if(!(q>0&&p>0))continue; const s=o.symbol; inventory[s] ||= {qty:0,cost:0}; const x=inventory[s];
    if(o.side==="buy"){x.cost+=q*p;x.qty+=q;continue;} if(x.qty<=0)continue; const sold=Math.min(q,x.qty),avg=x.cost/x.qty,pnl=sold*(p-avg); realizedPnl+=pnl; x.qty-=sold;x.cost-=sold*avg;completedTrades++;if(pnl>0)winningTrades++;if(x.qty<1e-8){x.qty=0;x.cost=0;}}
  return {realizedPnl,completedTrades,winningTrades,winRate:completedTrades?winningTrades/completedTrades:0};
}
async function renderDashboard(env) {
  const [orders,positions,account]=await Promise.all([
    alpaca(env,"/v2/orders?status=all&limit=150&direction=desc&nested=false"), alpaca(env,"/v2/positions"), alpaca(env,"/v2/account")
  ]);
  const botOrders=orders.filter(o=>String(o.client_order_id||"").startsWith("paper-"));
  const performance=calculatePerformance(botOrders.filter(o=>o.status==="filled"));
  const activeUniverse=new Set(universe(env));
  const botPositions=positions.filter(p=>activeUniverse.has(p.symbol));
  const unrealized=botPositions.reduce((s,p)=>s+(Number(p.unrealized_pl)||0),0);
  const rows=botOrders.slice(0,35).map(o=>`<tr><td>${escapeHtml(o.submitted_at?new Date(o.submitted_at).toLocaleString("en-US",{timeZone:"America/New_York"}):"—")}</td><td>${escapeHtml(o.symbol)}</td><td>${escapeHtml(String(o.side||"").toUpperCase())}</td><td>${escapeHtml(o.status)}</td><td>${o.filled_avg_price?money(o.filled_avg_price):"—"}</td></tr>`).join("");
  const symbols=universe(env).join(", ");
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Alpaca Intraday Paper Guard</title><style>:root{color-scheme:dark;--bg:#0b1020;--card:#151c32;--line:#2a3557;--text:#eef3ff;--muted:#9eabc9;--green:#2dd4a8}*{box-sizing:border-box}body{margin:0;background:#0b1020;font:15px system-ui;color:var(--text)}main{max-width:1200px;margin:auto;padding:28px 18px 50px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:17px}.label{color:var(--muted);font-size:12px;text-transform:uppercase}.value{font-size:24px;font-weight:750;margin-top:7px}.small{font-size:13px;color:var(--muted);margin-top:7px}header{display:flex;justify-content:space-between;gap:15px;align-items:center;margin-bottom:22px}.badge{border:1px solid var(--green);color:var(--green);padding:7px 11px;border-radius:999px;font-weight:700}table{width:100%;border-collapse:collapse;background:var(--card);margin-top:22px}th,td{text-align:left;padding:11px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px}</style></head><body><main><header><div><h1>Alpaca Intraday Paper Guard</h1><div class="small">Paper-only · 5-minute multi-symbol scanner · ${escapeHtml(symbols)}</div></div><div class="badge">${String(env.TRADING_ENABLED)==="true"?"ARMED":"DISABLED"}</div></header><div class="grid"><div class="card"><div class="label">Paper equity</div><div class="value">${money(account.equity)}</div><div class="small">Buying power ${money(account.buying_power)}</div></div><div class="card"><div class="label">Realized bot P&L</div><div class="value">${money(performance.realizedPnl)}</div><div class="small">${performance.completedTrades} completed exits</div></div><div class="card"><div class="label">Open P&L</div><div class="value">${money(unrealized)}</div><div class="small">${botPositions.length} active positions</div></div><div class="card"><div class="label">Win rate</div><div class="value">${percentage(performance.winRate)}</div><div class="small">${performance.winningTrades} winning exits</div></div><div class="card"><div class="label">Entry threshold</div><div class="value">${num(env.MIN_ENTRY_SCORE,65).toFixed(0)}</div><div class="small">Ranked momentum score</div></div><div class="card"><div class="label">Stop / target</div><div class="value">${percentage(pct(env.STOP_LOSS_PCT,0.006))} / ${percentage(pct(env.TAKE_PROFIT_PCT,0.018))}</div><div class="small">Paper-test defaults</div></div></div><table><thead><tr><th>Time ET</th><th>Symbol</th><th>Side</th><th>Status</th><th>Fill</th></tr></thead><tbody>${rows||'<tr><td colspan="5">No bot orders yet.</td></tr>'}</tbody></table><div class="small" style="margin-top:16px">Simulation only. Results can differ materially from live trading because of latency, fills, slippage, liquidity, and market regime changes.</div></main></body></html>`;
  return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
}

var index_default={
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method!=="GET")return Response.json({error:"not_found"},{status:404});
    if(url.pathname==="/api/status")return Response.json({service:"alpaca-paper-guard",strategy:"intraday-ranked-v2",status:String(env.TRADING_ENABLED)==="true"?"armed":"disabled",endpoint:"paper",symbols:universe(env),secretStatus:{keyIdConfigured:Boolean(env.APCA_API_KEY_ID),secretConfigured:Boolean(env.APCA_API_SECRET_KEY)}},{headers:{"Cache-Control":"no-store"}});
    if(url.pathname!=="/")return Response.json({error:"not_found"},{status:404});
    if(!env.DASHBOARD_PASSWORD)return Response.json({error:"dashboard_password_not_configured"},{status:503});
    if(!await isDashboardAuthorized(request,env))return new Response("Authentication required",{status:401,headers:{"WWW-Authenticate":'Basic realm="Alpaca Paper Guard"',"Cache-Control":"no-store"}});
    try{return await renderDashboard(env);}catch(error){console.error(JSON.stringify({event:"dashboard_failed",message:error instanceof Error?error.message:"unknown_error"}));return Response.json({error:"dashboard_unavailable"},{status:502});}
  },
  async scheduled(controller,env,ctx){ctx.waitUntil(runCycle(env,controller.scheduledTime).then(result=>console.log(JSON.stringify({event:"cycle_complete",...result}))).catch(error=>console.error(JSON.stringify({event:"cycle_failed",message:error instanceof Error?error.message:"unknown_error"}))));}
};
export { index_default as default };

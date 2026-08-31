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
function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return 0;
  const tr = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const h = Number(bars[i].h), l = Number(bars[i].l), pc = Number(bars[i-1].c);
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return average(tr);
}
function etParts(time) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:"America/New_York", hour12:false,
    year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"
  }).formatToParts(new Date(time));
  const get = type => Number(parts.find(p=>p.type===type)?.value || 0);
  return {year:get("year"), month:get("month"), day:get("day"), hour:get("hour"), minute:get("minute")};
}
function etDateKey(time) {
  const p = etParts(time);
  return `${p.year}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`;
}
function entryWindowOpen(time) {
  const {hour, minute} = etParts(time);
  const mins = hour * 60 + minute;
  return (mins >= 9*60+45 && mins <= 11*60+30) || (mins >= 13*60+30 && mins <= 15*60+15);
}
function barsToSignal(symbol, bars) {
  const clean = (bars || []).filter(b =>
    Number.isFinite(Number(b.c)) && Number.isFinite(Number(b.h)) &&
    Number.isFinite(Number(b.l)) && Number.isFinite(Number(b.v))
  );
  if (clean.length < 40) return { symbol, valid:false, reason:"insufficient_bars" };

  const closes = clean.map(b => Number(b.c));
  const highs = clean.map(b => Number(b.h));
  const lows = clean.map(b => Number(b.l));
  const volumes = clean.map(b => Number(b.v));
  const price = closes.at(-1);
  const ema9 = ema(closes.slice(-40), 9);
  const ema21 = ema(closes.slice(-50), 21);
  const priorEma9 = ema(closes.slice(-41,-1), 9);
  const priorEma21 = ema(closes.slice(-51,-1), 21);
  const rsi14 = rsi(closes, 14);
  const avgVol20 = average(volumes.slice(-21, -1));
  const relVolume = avgVol20 > 0 ? volumes.at(-1) / avgVol20 : 0;
  const high20 = Math.max(...highs.slice(-21, -1));
  const low20 = Math.min(...lows.slice(-21, -1));
  const ret1 = closes.length > 1 ? price / closes.at(-2) - 1 : 0;
  const ret3 = closes.length > 3 ? price / closes.at(-4) - 1 : 0;
  const ret6 = closes.length > 6 ? price / closes.at(-7) - 1 : 0;
  const returns = closes.slice(-21).slice(1).map((c,i) => c / closes.slice(-21)[i] - 1);
  const volatility = stddev(returns);
  const atr14 = atr(clean, 14);
  const atrPct = price > 0 ? atr14 / price : 0;

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
  const trendSlope = ema9 > priorEma9 && ema21 >= priorEma21;
  const breakout = price > high20 * 1.0002 && closes.at(-2) <= high20 * 1.001;
  const pullback = trend && trendSlope && aboveVwap && price >= ema9 * 0.999 && price <= ema9 * 1.0025;
  const momentum = ret3 > 0.0012 && ret6 > 0.0020;
  const healthyRsi = rsi14 >= 55 && rsi14 <= 72;
  const volumeConfirmed = relVolume >= 1.15;
  const notExtended = price <= Math.max(vwap, ema9) * 1.006;
  const saneVolatility = atrPct >= 0.0012 && atrPct <= 0.018;
  const greenBar = closes.at(-1) >= Number(clean.at(-1).o || closes.at(-2));
  const setupConfirmed = trend && trendSlope && aboveVwap && healthyRsi &&
    volumeConfirmed && notExtended && saneVolatility && greenBar &&
    (pullback || (breakout && momentum));

  let score = 0;
  if (trend) score += 18;
  if (trendSlope) score += 14;
  if (aboveVwap) score += 14;
  if (breakout) score += 16;
  if (pullback) score += 18;
  if (momentum) score += 12;
  if (healthyRsi) score += 8;
  if (volumeConfirmed) score += Math.min(12, 6 + Math.max(0, (relVolume - 1.15) * 8));
  if (notExtended) score += 6;
  if (saneVolatility) score += 6;
  if (rsi14 > 76) score -= 18;
  if (ret1 > 0.007) score -= 12;
  if (ret1 < -0.002) score -= 16;
  if (!trendSlope) score -= 12;
  if (!volumeConfirmed) score -= 10;

  return {
    symbol, valid:true, price, ema9, ema21, vwap, rsi14, relVolume, high20, low20,
    ret1, ret3, ret6, volatility, atrPct, breakout, pullback, momentum,
    trend, trendSlope, aboveVwap, healthyRsi, volumeConfirmed, notExtended,
    saneVolatility, setupConfirmed, score
  };
}
function entryReason(s) {
  if (s.pullback) return "confirmed_trend_pullback";
  if (s.breakout && s.momentum) return "confirmed_breakout_momentum";
  return "quality_ranked";
}
function marketRegime(signalMap) {
  const refs = ["SPY","QQQ"].map(s=>signalMap[s]).filter(Boolean);
  if (!refs.length) return {ok:true, reason:"no_benchmark"};
  const bullish = refs.filter(s => s.trend && s.trendSlope && s.aboveVwap && s.rsi14 >= 50).length;
  return {ok: bullish >= Math.ceil(refs.length / 2), reason: bullish ? "supportive" : "weak"};
}
function exitDecision(position, signal, env, now) {
  const entry = Number(position.avg_entry_price);
  const price = signal?.price || Number(position.current_price);
  const stopLoss = pct(env.STOP_LOSS_PCT, 0.0045);
  const takeProfit = pct(env.TAKE_PROFIT_PCT, 0.009);
  const trailTrigger = pct(env.TRAIL_TRIGGER_PCT, 0.0055);
  const trailGiveback = pct(env.TRAIL_GIVEBACK_PCT, 0.002);
  const pnlPct = entry > 0 ? price / entry - 1 : 0;

  if (pnlPct <= -stopLoss) return { exit:true, reason:"stop_loss", pnlPct };
  if (pnlPct >= takeProfit) return { exit:true, reason:"take_profit", pnlPct };
  if (pnlPct >= trailTrigger && signal && price < signal.ema9 * (1 - trailGiveback))
    return { exit:true, reason:"trailing_exit", pnlPct };
  if (pnlPct >= 0.0025 && signal && (!signal.trendSlope || price < signal.ema9))
    return { exit:true, reason:"profit_protect", pnlPct };
  if (signal && (!signal.trend || price < signal.vwap))
    return { exit:true, reason:"trend_failure", pnlPct };

  const {hour, minute} = etParts(now);
  if (hour > 15 || (hour === 15 && minute >= 55))
    return { exit:true, reason:"end_of_day_flatten", pnlPct };
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
function calculatePerformance(orders) {
  const sorted=[...orders].filter(o=>o.filled_at&&o.filled_avg_price)
    .sort((a,b)=>String(a.filled_at).localeCompare(String(b.filled_at)));
  const inventory={}; let realizedPnl=0,completedTrades=0,winningTrades=0,losingTrades=0;
  for(const o of sorted){
    const q=Number(o.filled_qty),p=Number(o.filled_avg_price);
    if(!(q>0&&p>0)) continue;
    const s=o.symbol; inventory[s] ||= {qty:0,cost:0}; const x=inventory[s];
    if(o.side==="buy"){x.cost+=q*p;x.qty+=q;continue;}
    if(x.qty<=0)continue;
    const sold=Math.min(q,x.qty),avg=x.cost/x.qty,pnl=sold*(p-avg);
    realizedPnl+=pnl; x.qty-=sold; x.cost-=sold*avg; completedTrades++;
    if(pnl>0) winningTrades++; else if(pnl<0) losingTrades++;
    if(x.qty<1e-8){x.qty=0;x.cost=0;}
  }
  return {realizedPnl,completedTrades,winningTrades,losingTrades,
    winRate:completedTrades?winningTrades/completedTrades:0};
}
function recentSymbolCooldowns(orders, now, minutes) {
  const cutoff = Number(now) - minutes * 60_000;
  const blocked = new Set();
  for (const o of orders) {
    if (o.side !== "sell" || o.status !== "filled" || !String(o.client_order_id||"").startsWith("paper-")) continue;
    const t = Date.parse(o.filled_at || o.updated_at || 0);
    if (Number.isFinite(t) && t >= cutoff) blocked.add(o.symbol);
  }
  return blocked;
}
function todayBotPerformance(orders, now) {
  const key = etDateKey(now);
  const today = orders.filter(o => o.status === "filled" &&
    String(o.client_order_id||"").startsWith("paper-") &&
    o.filled_at && etDateKey(o.filled_at) === key);
  return calculatePerformance(today);
}
function techExposureCount(positions) {
  const tech = new Set(["QQQ","NVDA","AAPL","TSLA","AMD","AMZN","META","MSFT"]);
  return positions.filter(p=>tech.has(p.symbol)).length;
}
async function runCycle(env, scheduledTime) {
  if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) throw new Error("missing_alpaca_secrets");
  if (String(env.TRADING_ENABLED) !== "true") return {status:"disabled", endpoint:"paper"};
  const clock = await alpaca(env, "/v2/clock");
  if (!clock.is_open) return {status:"market_closed", endpoint:"paper"};

  const symbols = universe(env);
  const barLimit = 80;
  // Alpaca's multi-symbol historical-bars limit is shared across symbols and
  // results are symbol-sorted, which can starve later symbols. Fetch each
  // symbol independently and request newest-first so indicators have enough
  // cross-session history even near the market open.
  const barResults = await Promise.all(symbols.map(async symbol => {
    const data = await marketData(env,
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=5Min&limit=${barLimit}&feed=iex&adjustment=raw&sort=desc`
    );
    const bars = Array.isArray(data.bars) ? [...data.bars].reverse() : [];
    return [symbol, bars];
  }));
  const barsBySymbol = Object.fromEntries(barResults);
  const signals = symbols.map(s => barsToSignal(s, barsBySymbol[s] || [])).filter(s => s.valid);
  const signalMap = Object.fromEntries(signals.map(s => [s.symbol, s]));

  const [positions, openOrders, recentOrders, account] = await Promise.all([
    alpaca(env, "/v2/positions"),
    alpaca(env, "/v2/orders?status=open&direction=desc&nested=false"),
    alpaca(env, "/v2/orders?status=all&limit=200&direction=desc&nested=false"),
    alpaca(env, "/v2/account")
  ]);

  const botOpenSymbols = new Set(openOrders
    .filter(o => String(o.client_order_id||"").startsWith("paper-")).map(o => o.symbol));
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

  const minScore = num(env.MIN_ENTRY_SCORE, 82);
  const maxPositions = int(env.MAX_CONCURRENT_POSITIONS, 2);
  const orderNotional = num(env.ORDER_NOTIONAL_USD, 5);
  const maxPosition = num(env.MAX_POSITION_USD, orderNotional);
  const maxTotalExposure = num(env.MAX_TOTAL_EXPOSURE_USD, Math.max(maxPosition, orderNotional * maxPositions));
  const currentExposure = botPositions.reduce((sum,p)=>sum + Math.abs(Number(p.market_value)||0),0);
  const occupied = new Set(botPositions.map(p=>p.symbol));
  let slots = Math.max(0, maxPositions - botPositions.length);
  let remainingExposure = Math.max(0, maxTotalExposure - currentExposure);
  const buyingPower = Math.max(0, Number(account.buying_power)||0);

  const regime = marketRegime(signalMap);
  const daily = todayBotPerformance(recentOrders, scheduledTime);
  const equity = Math.max(1, Number(account.equity)||1);
  const maxDailyLossPct = pct(env.MAX_DAILY_LOSS_PCT, 0.01);
  const dailyLossGuard = daily.realizedPnl <= -(equity * maxDailyLossPct);
  const maxDailyLosingExits = int(env.MAX_DAILY_LOSING_EXITS, 3);
  const lossCountGuard = daily.losingTrades >= maxDailyLosingExits;
  const cooldownMinutes = int(env.SYMBOL_COOLDOWN_MINUTES, 45);
  const cooldowns = recentSymbolCooldowns(recentOrders, scheduledTime, cooldownMinutes);
  const canOpenNewRisk = entryWindowOpen(scheduledTime) && regime.ok && !dailyLossGuard && !lossCountGuard;
  const currentTech = techExposureCount(botPositions);

  const candidates = signals
    .filter(s =>
      canOpenNewRisk &&
      !occupied.has(s.symbol) &&
      !botOpenSymbols.has(s.symbol) &&
      !cooldowns.has(s.symbol) &&
      s.setupConfirmed &&
      s.score >= minScore &&
      !(currentTech >= 1 && ["QQQ","NVDA","AAPL","TSLA","AMD","AMZN","META","MSFT"].includes(s.symbol))
    )
    .sort((a,b)=>b.score-a.score);

  let techAdded = currentTech;
  for (const candidate of candidates) {
    if (slots <= 0 || remainingExposure < 1) break;
    const isTech = ["QQQ","NVDA","AAPL","TSLA","AMD","AMZN","META","MSFT"].includes(candidate.symbol);
    if (isTech && techAdded >= 1) continue;
    const notional = Math.min(orderNotional, maxPosition, remainingExposure, buyingPower);
    if (notional < 1) break;
    await placeMarketBuy(env, candidate.symbol, notional, scheduledTime);
    actions.push({
      action:"buy", symbol:candidate.symbol, reason:entryReason(candidate),
      score:Number(candidate.score.toFixed(1)), price:candidate.price
    });
    slots -= 1;
    remainingExposure -= notional;
    botOpenSymbols.add(candidate.symbol);
    if (isTech) techAdded += 1;
  }

  return {
    status: actions.length ? "acted" : "hold",
    endpoint:"paper",
    strategy:"intraday-quality-v7",
    universe:symbols,
    scanned:signals.length,
    qualified:candidates.length,
    entryWindow:entryWindowOpen(scheduledTime),
    regime,
    daily:{realizedPnl:Number(daily.realizedPnl.toFixed(2)),losingTrades:daily.losingTrades},
    guards:{dailyLossGuard,lossCountGuard},
    actions,
    leaders:signals.sort((a,b)=>b.score-a.score).slice(0,5).map(s=>({
      symbol:s.symbol,score:Number(s.score.toFixed(1)),price:s.price,
      rvol:Number(s.relVolume.toFixed(2)),rsi:Number(s.rsi14.toFixed(1)),
      confirmed:s.setupConfirmed
    }))
  };
}
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function money(value) { return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(value)||0); }
function percentage(value) { return `${((Number(value)||0)*100).toFixed(2)}%`; }
async function digest(value) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
async function secureEqual(left,right) {
  const [a,b]=await Promise.all([digest(left),digest(right)]);
  if(a.length!==b.length)return false;
  let d=0; for(let i=0;i<a.length;i++)d|=a[i]^b[i]; return d===0;
}
async function isDashboardAuthorized(request, env) {
  if (!env.DASHBOARD_PASSWORD) return false;
  const auth=request.headers.get("Authorization"); if(!auth?.startsWith("Basic ")) return false;
  try {
    const decoded=atob(auth.slice(6)); const i=decoded.indexOf(":");
    return i>=0 && secureEqual(decoded.slice(i+1),env.DASHBOARD_PASSWORD);
  } catch { return false; }
}
async function renderDashboard(env) {
  const [orders,positions,account]=await Promise.all([
    alpaca(env,"/v2/orders?status=all&limit=200&direction=desc&nested=false"),
    alpaca(env,"/v2/positions"),
    alpaca(env,"/v2/account")
  ]);
  const botOrders=orders.filter(o=>String(o.client_order_id||"").startsWith("paper-"));
  const performance=calculatePerformance(botOrders.filter(o=>o.status==="filled"));
  const activeUniverse=new Set(universe(env));
  const botPositions=positions.filter(p=>activeUniverse.has(p.symbol));
  const unrealized=botPositions.reduce((s,p)=>s+(Number(p.unrealized_pl)||0),0);
  const rows=botOrders.slice(0,35).map(o=>`<tr><td>${escapeHtml(o.submitted_at?new Date(o.submitted_at).toLocaleString("en-US",{timeZone:"America/New_York"}):"—")}</td><td>${escapeHtml(o.symbol)}</td><td>${escapeHtml(String(o.side||"").toUpperCase())}</td><td>${escapeHtml(o.status)}</td><td>${o.filled_avg_price?money(o.filled_avg_price):"—"}</td></tr>`).join("");
  const symbols=universe(env).join(", ");
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Alpaca Intraday Quality Guard</title><style>:root{color-scheme:dark;--bg:#0b1020;--card:#151c32;--line:#2a3557;--text:#eef3ff;--muted:#9eabc9;--green:#2dd4a8}*{box-sizing:border-box}body{margin:0;background:var(--bg);font:15px system-ui;color:var(--text)}main{max-width:1200px;margin:auto;padding:28px 18px 50px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:17px}.label{color:var(--muted);font-size:12px;text-transform:uppercase}.value{font-size:24px;font-weight:750;margin-top:7px}.small{font-size:13px;color:var(--muted);margin-top:7px}header{display:flex;justify-content:space-between;gap:15px;align-items:center;margin-bottom:22px}.badge{border:1px solid var(--green);color:var(--green);padding:7px 11px;border-radius:999px;font-weight:700}table{width:100%;border-collapse:collapse;background:var(--card);margin-top:22px}th,td{text-align:left;padding:11px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px}</style></head><body><main><header><div><h1>Alpaca Intraday Quality Guard v7</h1><div class="small">Paper-only · stricter confirmation · market-regime and loss guards · ${escapeHtml(symbols)}</div></div><div class="badge">${String(env.TRADING_ENABLED)==="true"?"ARMED":"DISABLED"}</div></header><div class="grid"><div class="card"><div class="label">Paper equity</div><div class="value">${money(account.equity)}</div><div class="small">Buying power ${money(account.buying_power)}</div></div><div class="card"><div class="label">Realized bot P&L</div><div class="value">${money(performance.realizedPnl)}</div><div class="small">${performance.completedTrades} completed exits</div></div><div class="card"><div class="label">Open P&L</div><div class="value">${money(unrealized)}</div><div class="small">${botPositions.length} active positions</div></div><div class="card"><div class="label">Win rate</div><div class="value">${percentage(performance.winRate)}</div><div class="small">${performance.winningTrades} wins / ${performance.losingTrades} losses</div></div><div class="card"><div class="label">Entry threshold</div><div class="value">${num(env.MIN_ENTRY_SCORE,82).toFixed(0)}</div><div class="small">Confirmed setups only</div></div><div class="card"><div class="label">Stop / target</div><div class="value">${percentage(pct(env.STOP_LOSS_PCT,0.0045))} / ${percentage(pct(env.TAKE_PROFIT_PCT,0.009))}</div><div class="small">Faster loss cutting + realistic target</div></div></div><table><thead><tr><th>Time ET</th><th>Symbol</th><th>Side</th><th>Status</th><th>Fill</th></tr></thead><tbody>${rows||'<tr><td colspan="5">No bot orders yet.</td></tr>'}</tbody></table><div class="small" style="margin-top:16px">Simulation only. No strategy can guarantee a higher win rate or profit; validate changes through paper trading before considering live capital.</div></main></body></html>`;
  return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
}

var index_default={
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method!=="GET")return Response.json({error:"not_found"},{status:404});
    if(url.pathname==="/api/status")return Response.json({
      service:"alpaca-paper-guard",strategy:"intraday-quality-v7",
      status:String(env.TRADING_ENABLED)==="true"?"armed":"disabled",endpoint:"paper",
      symbols:universe(env),
      safeguards:{
        minEntryScore:num(env.MIN_ENTRY_SCORE,82),
        maxConcurrentPositions:int(env.MAX_CONCURRENT_POSITIONS,2),
        maxDailyLossPct:pct(env.MAX_DAILY_LOSS_PCT,0.01),
        maxDailyLosingExits:int(env.MAX_DAILY_LOSING_EXITS,3),
        symbolCooldownMinutes:int(env.SYMBOL_COOLDOWN_MINUTES,45)
      },
      secretStatus:{keyIdConfigured:Boolean(env.APCA_API_KEY_ID),secretConfigured:Boolean(env.APCA_API_SECRET_KEY)}
    },{headers:{"Cache-Control":"no-store"}});
    if(url.pathname!=="/")return Response.json({error:"not_found"},{status:404});
    if(!env.DASHBOARD_PASSWORD)return Response.json({error:"dashboard_password_not_configured"},{status:503});
    if(!await isDashboardAuthorized(request,env))return new Response("Authentication required",{status:401,headers:{"WWW-Authenticate":'Basic realm="Alpaca Paper Guard"',"Cache-Control":"no-store"}});
    try{return await renderDashboard(env);}
    catch(error){console.error(JSON.stringify({event:"dashboard_failed",message:error instanceof Error?error.message:"unknown_error"}));return Response.json({error:"dashboard_unavailable"},{status:502});}
  },
  async scheduled(controller,env,ctx){
    ctx.waitUntil(runCycle(env,controller.scheduledTime)
      .then(result=>console.log(JSON.stringify({event:"cycle_complete",...result})))
      .catch(error=>console.error(JSON.stringify({event:"cycle_failed",message:error instanceof Error?error.message:"unknown_error"}))));
  }
};
export { index_default as default };

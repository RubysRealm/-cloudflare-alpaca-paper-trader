import { alpaca, fetchLatestQuote, fetchBars, fetchSnapshots } from './api.js';
import { timeframeSignal, combineSignals } from './signals.js';
import { botLotsFromOrders } from './performance.js';
import { pct, num, int, clamp, round } from './config.js';
import {
  runStockFreeTier as coreRunStockFreeTier,
  stockFreeTierStatus as coreStockFreeTierStatus,
  stockOpportunityDiagnostics as coreStockOpportunityDiagnostics,
  STOCK_STRATEGY
} from './free-tier-stock.js';

export { STOCK_STRATEGY };

const BOT_PREFIX='paper8-';
const isBotOrder=o=>String(o?.client_order_id||'').startsWith(BOT_PREFIX);
const isStockPosition=p=>String(p?.asset_class||'').toLowerCase()!=='crypto'&&!String(p?.symbol||'').includes('/');
const cid=(side,symbol,now,tag)=>`${BOT_PREFIX}${side}-${tag}-${symbol}-${Number(now).toString(36)}`.replace(/--+/g,'-').slice(0,48);

function quoteFields(q={}){
  const bid=+(q.bp??q.bid_price??0),ask=+(q.ap??q.ask_price??0),bidSize=+(q.bs??q.bid_size??0),askSize=+(q.as??q.ask_size??0);
  const mid=bid>0&&ask>0?(bid+ask)/2:0;
  const spread=mid>0&&ask>=bid?(ask-bid)/mid:1;
  return{bid,ask,bidSize,askSize,mid,spread};
}

function openBotOrderSymbols(orders=[]){
  return new Set(orders.filter(o=>isBotOrder(o)&&['new','accepted','pending_new','partially_filled'].includes(String(o.status||'').toLowerCase())).map(o=>String(o.symbol||'').toUpperCase()));
}

function profitableExitCycles(orders=[],now,env){
  const maxAge=Math.max(15,int(env.STOCK_SWING_REENTRY_MAX_AGE_MINUTES,180))*60000;
  const bySymbol=new Map();
  for(const o of [...orders].filter(o=>isBotOrder(o)&&o?.status==='filled'&&(+o.filled_avg_price||0)>0&&(+o.filled_qty||0)>0).sort((a,b)=>String(a.filled_at||a.submitted_at||'').localeCompare(String(b.filled_at||b.submitted_at||'')))){
    const symbol=String(o.symbol||'').toUpperCase();
    let s=bySymbol.get(symbol);if(!s){s={qty:0,cost:0,lastPositiveExit:null};bySymbol.set(symbol,s);}
    const qty=Math.abs(+o.filled_qty||0),price=+o.filled_avg_price||0,t=Date.parse(o.filled_at||o.submitted_at||'');
    if(o.side==='buy'){
      s.qty+=qty;s.cost+=qty*price;continue;
    }
    if(o.side!=='sell'||!(s.qty>1e-8))continue;
    const sold=Math.min(qty,s.qty),avg=s.cost/s.qty,realized=(price-avg)*sold;
    s.qty-=sold;s.cost-=avg*sold;
    if(s.qty<1e-8){s.qty=0;s.cost=0;}
    if(realized>0&&s.qty<=1e-8&&Number.isFinite(t))s.lastPositiveExit={symbol,salePrice:price,realizedPnl:realized,filledAt:t,clientOrderId:o.client_order_id};
  }
  const out=[];
  for(const s of bySymbol.values()){
    const x=s.lastPositiveExit;
    if(x&&Number(now)-x.filledAt>=0&&Number(now)-x.filledAt<=maxAge)out.push(x);
  }
  return out.sort((a,b)=>b.filledAt-a.filledAt);
}

async function signalFor(env,symbol,snapshot){
  const [m1,m5,m15]=await Promise.all([
    fetchBars(env,symbol,'1Min',45),
    fetchBars(env,symbol,'5Min',45),
    fetchBars(env,symbol,'15Min',45)
  ]);
  const s1=timeframeSignal(symbol,m1.bars),s5=timeframeSignal(symbol,m5.bars),s15=timeframeSignal(symbol,m15.bars);
  const combined=combineSignals(symbol,s1,s5,s15,snapshot||{});
  const highs=(m1.bars||[]).slice(-10).map(x=>+x.h||0).filter(x=>x>0);
  const recentHigh=highs.length?Math.max(...highs):0;
  return{combined,s1,s5,s15,recentHigh};
}

function swingThresholds(env,spread){
  const entrySlip=pct(env.MAX_ENTRY_SLIPPAGE_PCT,0.001),exitSlip=pct(env.MAX_EXIT_SLIPPAGE_PCT,0.0012);
  const friction=Math.max(0,spread)+entrySlip+exitSlip;
  const minProfit=Math.max(pct(env.STOCK_SWING_HARVEST_MIN_PCT,0.0065),friction+pct(env.STOCK_SWING_MIN_NET_EDGE_PCT,0.003));
  const hardProfit=Math.max(pct(env.STOCK_SWING_HARD_HARVEST_PCT,0.011),minProfit*1.45);
  return{friction,minProfit,hardProfit};
}

async function placeSwingSell(env,p,qty,bid,entry,thresholds,now){
  const buffer=pct(env.STOCK_SWING_EXIT_BUFFER_PCT,0.00015);
  const protectedFloor=entry*(1+thresholds.friction+pct(env.STOCK_SWING_MIN_LOCKED_PROFIT_PCT,0.002));
  const raw=Math.max(protectedFloor,bid*(1-buffer));
  const limit=Math.max(0.01,Math.floor(raw*100)/100);
  if(!(limit<=bid&&qty>0))return null;
  return alpaca(env,'/v2/orders',{method:'POST',body:JSON.stringify({
    symbol:p.symbol,qty:qty.toFixed(8),side:'sell',type:'limit',limit_price:limit.toFixed(2),time_in_force:'day',
    client_order_id:cid('sell',p.symbol,now,'swingcap')
  })});
}

async function trySwingHarvestAll(env,now,positions,orders){
  const lots=botLotsFromOrders(orders),open=openBotOrderSymbols(orders),botPositions=(positions||[]).filter(p=>isStockPosition(p)&&lots[p.symbol]?.qty>1e-8);
  if(!botPositions.length)return[];
  const symbols=botPositions.map(p=>p.symbol),snap=(await fetchSnapshots(env,symbols)).snapshots||{},actions=[];
  for(const p of botPositions){
    if(open.has(p.symbol))continue;
    const lot=lots[p.symbol],qty=Math.min(Math.abs(+p.qty||0),lot.qty||0),entry=+(lot.avgEntry||p.avg_entry_price||0);
    if(!(qty>1e-8&&entry>0))continue;
    let q;try{q=quoteFields((await fetchLatestQuote(env,p.symbol)).quote||{});}catch{continue;}
    if(!(q.bid>0&&q.ask>0))continue;
    const pnl=q.bid/entry-1,th=swingThresholds(env,q.spread);
    if(pnl<th.minProfit)continue;
    let sig;try{sig=await signalFor(env,p.symbol,snap[p.symbol]||{});}catch{continue;}
    const pullbackFromHigh=sig.recentHigh>0?q.bid/sig.recentHigh-1:0;
    const rollover=Boolean((sig.s1?.ret1||0)<0||(sig.s1?.ret3||0)<0||(sig.s1?.ema9>0&&q.bid<sig.s1.ema9));
    const profitFade=Boolean(pullbackFromHigh<=-pct(env.STOCK_SWING_PEAK_GIVEBACK_PCT,0.002));
    const hardHarvest=pnl>=th.hardProfit;
    if(!(hardHarvest||rollover||profitFade))continue;
    try{
      const o=await placeSwingSell(env,p,qty,q.bid,entry,th,now);
      if(!o)continue;
      actions.push({
        action:'swing_harvest_sell',symbol:p.symbol,reason:hardHarvest?'hard_profit_harvest':profitFade?'peak_giveback':'momentum_rollover',
        pnlPct:round(pnl,5),estimatedGrossProfitUsd:round((q.bid-entry)*qty,2),entry:round(entry,4),bid:round(q.bid,4),
        recentHigh:round(sig.recentHigh,4),pullbackFromHighPct:round(pullbackFromHigh,5),minHarvestPct:round(th.minProfit,5),hardHarvestPct:round(th.hardProfit,5),
        orderStatus:o?.status||null,orderType:o?.type||null
      });
    }catch(e){actions.push({action:'swing_harvest_failed',symbol:p.symbol,reason:e.message});}
  }
  return actions;
}

function reboundOk(sig,ask,salePrice,env){
  if(!sig?.combined?.valid||!(ask>0&&salePrice>0))return false;
  const pullback=ask/salePrice-1;
  const minPull=-pct(env.STOCK_SWING_REENTRY_PULLBACK_PCT,0.0045),maxDrop=-pct(env.STOCK_SWING_REENTRY_MAX_DROP_PCT,0.04);
  if(!(pullback<=minPull&&pullback>=maxDrop))return false;
  const s1=sig.s1||{},s5=sig.s5||{},s15=sig.s15||{};
  const rebound=(s1.ret1||0)>0&&(s1.ret3||0)>-0.0015;
  const rsi=+(s5.rsi14??50),notOverbought=rsi>=32&&rsi<=70;
  const trendNotBroken=Boolean(!s15.downTrend||(s15.ret1||0)>-0.0035);
  const ref=Math.max(s5.ema9||0,s5.vwap||0),nearValue=Boolean(!(ref>0)||ask<=ref*1.0045);
  return rebound&&notOverbought&&trendNotBroken&&nearValue;
}

async function trySwingReentries(env,now,positions,orders,account){
  const lots=botLotsFromOrders(orders),botPositions=(positions||[]).filter(p=>isStockPosition(p)&&lots[p.symbol]?.qty>1e-8),maxPos=int(env.STOCK_MAX_CONCURRENT_POSITIONS,4);
  let slots=Math.max(0,maxPos-botPositions.length);if(!slots)return[];
  const sales=profitableExitCycles(orders,now,env);if(!sales.length)return[];
  const minWait=Math.max(1,int(env.STOCK_SWING_REENTRY_MIN_WAIT_MINUTES,1))*60000,open=openBotOrderSymbols(orders),actions=[];
  for(const sale of sales){
    if(slots<=0)break;
    const symbol=sale.symbol;
    if(Number(now)-sale.filledAt<minWait||open.has(symbol))continue;
    const laterBuy=orders.some(o=>o?.side==='buy'&&o?.status==='filled'&&String(o.symbol||'').toUpperCase()===symbol&&Date.parse(o.filled_at||o.submitted_at||'')>sale.filledAt);
    if(laterBuy)continue;
    let q;try{q=quoteFields((await fetchLatestQuote(env,symbol)).quote||{});}catch{continue;}
    if(!(q.ask>0&&sale.salePrice>0)||q.spread>pct(env.STOCK_MAX_SPREAD_PCT,0.002))continue;
    const pullbackPct=q.ask/sale.salePrice-1;
    if(pullbackPct>-pct(env.STOCK_SWING_REENTRY_PULLBACK_PCT,0.0045)||pullbackPct<-pct(env.STOCK_SWING_REENTRY_MAX_DROP_PCT,0.04))continue;
    let snap={};try{snap=(await fetchSnapshots(env,[symbol])).snapshots||{};}catch{continue;}
    let sig;try{sig=await signalFor(env,symbol,snap[symbol]||{});}catch{continue;}
    if(!reboundOk(sig,q.ask,sale.salePrice,env))continue;
    const bp=Math.max(0,+account.buying_power||0),base=Math.min(num(env.STOCK_ORDER_NOTIONAL_USD,12000),num(env.STOCK_MAX_POSITION_USD,12000),bp);
    const notional=base*clamp(num(env.STOCK_SWING_REENTRY_SIZE_MULTIPLIER,1),0.5,1);
    if(notional<1)continue;
    const slip=pct(env.MAX_ENTRY_SLIPPAGE_PCT,0.001),limit=q.ask*(1+slip),qty=Math.floor((notional/limit)*1e8)/1e8;
    if(!(qty>0))continue;
    try{
      const o=await alpaca(env,'/v2/orders',{method:'POST',body:JSON.stringify({
        symbol,qty:qty.toFixed(8),side:'buy',type:'limit',limit_price:limit.toFixed(2),time_in_force:'day',
        client_order_id:cid('buy',symbol,now,'swingrebuy')
      })});
      actions.push({
        action:'swing_reentry_buy',symbol,reason:'buyback_after_profitable_swing_pullback',salePrice:round(sale.salePrice,4),ask:round(q.ask,4),
        priorRealizedProfitUsd:round(sale.realizedPnl,2),pullbackFromSalePct:round(pullbackPct,5),notional:round(notional,2),
        rsi5m:round(sig.s5?.rsi14||0,2),ret1m:round(sig.s1?.ret1||0,5),ret5m:round(sig.s5?.ret1||0,5),orderStatus:o?.status||null,orderType:o?.type||null
      });
      slots--;
    }catch(e){actions.push({action:'swing_reentry_failed',symbol,reason:e.message});}
  }
  return actions;
}

export async function runStockFreeTier(env,now,{discover=true}={}){
  let clock;try{clock=await alpaca(env,'/v2/clock');}catch{return coreRunStockFreeTier(env,now,{discover});}
  if(!clock?.is_open)return coreRunStockFreeTier(env,now,{discover});

  const riskFirst=await coreRunStockFreeTier(env,now,{discover:false});
  if((riskFirst.actions||[]).length)return riskFirst;

  try{
    const [positions,orders,account]=await Promise.all([
      alpaca(env,'/v2/positions'),
      alpaca(env,'/v2/orders?status=all&limit=300&direction=desc&nested=false'),
      alpaca(env,'/v2/account')
    ]);
    const harvest=await trySwingHarvestAll(env,now,positions,orders);
    if(harvest.some(a=>a.action==='swing_harvest_sell'))return{status:'acted',strategy:STOCK_STRATEGY,mode:'portfolio_swing_harvest',actions:harvest};
    if(discover&&String(env.NEW_STOCK_ENTRIES_ENABLED??'false')==='true'){
      const reentries=await trySwingReentries(env,now,positions,orders,account);
      if(reentries.some(a=>a.action==='swing_reentry_buy'))return{status:'acted',strategy:STOCK_STRATEGY,mode:'portfolio_swing_reentry',actions:reentries};
    }
  }catch(e){console.log(JSON.stringify({event:'stock_swing_runtime_degraded',message:e.message}));}

  return coreRunStockFreeTier(env,now,{discover});
}

export async function stockOpportunityDiagnostics(env,now=Date.now()){
  const d=await coreStockOpportunityDiagnostics(env,now);
  let recent=[];
  try{
    const orders=await alpaca(env,'/v2/orders?status=all&limit=300&direction=desc&nested=false');
    recent=profitableExitCycles(orders,now,env).slice(0,8).map(x=>({symbol:x.symbol,salePrice:round(x.salePrice,4),realizedPnl:round(x.realizedPnl,2),filledAt:new Date(x.filledAt).toISOString()}));
  }catch{}
  return{...d,swingCycle:{enabled:true,portfolioWide:true,maxPositions:int(env.STOCK_MAX_CONCURRENT_POSITIONS,4),harvestMinPct:pct(env.STOCK_SWING_HARVEST_MIN_PCT,0.0065),hardHarvestPct:pct(env.STOCK_SWING_HARD_HARVEST_PCT,0.011),peakGivebackPct:pct(env.STOCK_SWING_PEAK_GIVEBACK_PCT,0.002),reentryPullbackPct:pct(env.STOCK_SWING_REENTRY_PULLBACK_PCT,0.0045),reentryMaxDropPct:pct(env.STOCK_SWING_REENTRY_MAX_DROP_PCT,0.04),recentProfitableExits:recent}};
}

export function stockFreeTierStatus(env){
  const s=coreStockFreeTierStatus(env);
  return{...s,maxPositions:int(env.STOCK_MAX_CONCURRENT_POSITIONS,4),freeTier:{...(s.freeTier||{}),architecture:'marketwide_multi_position_swing_harvest_reentry'},research:{...(s.research||{}),portfolioWideSwingHarvest:true,profitFadeHarvest:true,profitableExitReentry:true,pullbackReboundReentry:true,repeatableSwingCycles:true,antiChurnReentry:true}};
}

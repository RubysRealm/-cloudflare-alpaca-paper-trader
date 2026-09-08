import { alpaca, marketDataRaw } from './api.js';
import { num, pct, int, clamp, round } from './config.js';

export const CRYPTO_STRATEGY='free-tier-crypto-v22';
export const CRYPTO_PREFIX='papercrypto-v22-';

const MEGA_CAPS=new Set(['BTC/USD','ETH/USD','SOL/USD']);
const STABLES=new Set(['USDC/USD','USDT/USD','USDG/USD']);
const norm=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const cid=(side,symbol,now,tag)=>`${CRYPTO_PREFIX}${side}-${tag}-${norm(symbol)}-${Number(now).toString(36)}`.slice(0,48);
let assetCache={at:0,assets:[]};

async function assets(env){
  if(assetCache.assets.length&&Date.now()-assetCache.at<300000)return assetCache.assets;
  const a=await alpaca(env,'/v2/assets?status=active&asset_class=crypto');
  const xs=(Array.isArray(a)?a:[]).filter(x=>x?.symbol&&x.tradable!==false&&x.status!=='inactive'&&String(x.symbol).endsWith('/USD')&&!STABLES.has(String(x.symbol).toUpperCase()));
  if(xs.length)assetCache={at:Date.now(),assets:xs};
  return assetCache.assets;
}

async function snapshots(env,symbols){
  const d=await marketDataRaw(env,`/v1beta3/crypto/us/snapshots?symbols=${symbols.map(encodeURIComponent).join(',')}`);
  return d?.snapshots||d||{};
}

async function recentBars(env,symbols,now){
  if(!symbols.length)return{};
  const start=new Date(Number(now)-32*60000).toISOString();
  const d=await marketDataRaw(env,`/v1beta3/crypto/us/bars?symbols=${symbols.map(encodeURIComponent).join(',')}&timeframe=1Min&start=${encodeURIComponent(start)}&limit=800&sort=asc`);
  return d?.bars||{};
}

function fields(s={}){
  const q=s.latestQuote||s.latest_quote||{},m=s.minuteBar||s.minute_bar||{},d=s.dailyBar||s.daily_bar||{},p=s.prevDailyBar||s.prev_daily_bar||{};
  const bid=+(q.bp??q.bid_price??0),ask=+(q.ap??q.ask_price??0),bidSize=+(q.bs??q.bid_size??0),askSize=+(q.as??q.ask_size??0);
  const mid=bid>0&&ask>0?(bid+ask)/2:+(m.c??m.close??d.c??d.close??0),spread=mid>0&&ask>=bid?(ask-bid)/mid:1;
  const mo=+(m.o??m.open??0),mc=+(m.c??m.close??mid),dc=+(d.c??d.close??mid),pc=+(p.c??p.close??0),vol=+(d.v??d.volume??0);
  const dollarVolume=Math.max(0,dc*vol),bidNotional=Math.max(0,bid*bidSize),askNotional=Math.max(0,ask*askSize),quoteNotional=Math.max(0,Math.min(bidNotional,askNotional));
  return{bid,ask,bidSize,askSize,bidNotional,askNotional,mid,spread,minRet:mo>0?mc/mo-1:0,dayRet:pc>0?dc/pc-1:0,dollarVolume,quoteNotional};
}

function barResearch(arr=[]){
  const xs=(Array.isArray(arr)?arr:[]).filter(x=>+(x.c??x.close??0)>0);
  const close=x=>+(x.c??x.close??0),open=x=>+(x.o??x.open??0),vol=x=>Math.max(0,+(x.v??x.volume??0));
  const ret=n=>{if(xs.length<2)return 0;const end=close(xs[xs.length-1]),idx=Math.max(0,xs.length-1-n),start=close(xs[idx]);return start>0?end/start-1:0;};
  const last5=xs.slice(-5),last3=xs.slice(-3),prev=xs.slice(-10,-3);
  const positive5=last5.filter(x=>close(x)>open(x)).length;
  const avg=a=>a.length?a.reduce((z,x)=>z+vol(x),0)/a.length:0,lastVol=avg(last3),prevVol=avg(prev),volumeExpansion=prevVol>0?lastVol/prevVol:(lastVol>0?1:0);
  return{historyOk:xs.length>=12,barCount:xs.length,ret5:ret(5),ret15:ret(15),ret30:ret(30),positive5,volumeExpansion};
}

function fmtPrice(price,asset,ceil=true){
  const inc=Math.max(1e-12,+(asset?.price_increment||0.00000001));
  const u=ceil?Math.ceil(price/inc):Math.floor(price/inc);
  return String(Math.max(inc,u*inc));
}

function fmtQty(qty,asset){
  const inc=Math.max(1e-12,+(asset?.min_trade_increment||asset?.min_order_size||0.00000001));
  return String(Math.floor((qty+inc*1e-8)/inc)*inc);
}

async function buy(env,c,asset,notional,now,tag='mtf'){
  if(!(c.ask>0))return null;
  const buffer=pct(env.CRYPTO_ENTRY_LIMIT_BUFFER_PCT,0.0015),limit=+(fmtPrice(c.ask*(1+buffer),asset,true)),qty=fmtQty(notional/limit,asset);
  if(!(Number(qty)>0))return null;
  return alpaca(env,'/v2/orders',{method:'POST',body:JSON.stringify({symbol:c.symbol,qty,side:'buy',type:'limit',limit_price:String(limit),time_in_force:'ioc',client_order_id:cid('buy',c.symbol,now,tag)})});
}

async function sell(env,p,asset,bid,entry,now,reason,profitFloorPct=0){
  if(!(bid>0))return null;
  const qty=fmtQty(Math.abs(+p.qty||0),asset);
  if(!(Number(qty)>0))return null;
  if(reason==='takeprofit'||reason==='profitfade'||reason==='rotate'){
    const protectedFloor=entry>0?entry*(1+profitFloorPct):bid;
    const lim=fmtPrice(Math.max(protectedFloor,bid*(1-pct(env.CRYPTO_PROFIT_EXIT_PRICE_BUFFER_PCT,0.0005))),asset,true);
    return alpaca(env,'/v2/orders',{method:'POST',body:JSON.stringify({symbol:asset.symbol,qty,side:'sell',type:'limit',limit_price:lim,time_in_force:'ioc',client_order_id:cid('sell',asset.symbol,now,reason)})});
  }
  return alpaca(env,'/v2/orders',{method:'POST',body:JSON.stringify({symbol:asset.symbol,qty,side:'sell',type:'market',time_in_force:'gtc',client_order_id:cid('sell',asset.symbol,now,reason)})});
}

async function cancelStaleOrders(env,orders,now){
  const out=[],ttl=int(env.CRYPTO_STALE_ORDER_SECONDS,120)*1000;
  for(const o of orders||[]){
    const id=String(o?.client_order_id||''),status=String(o?.status||'').toLowerCase();
    if(!id.startsWith('papercrypto-')||!['new','accepted','pending_new','partially_filled'].includes(status))continue;
    const t=Date.parse(o?.submitted_at||'');
    if(!Number.isFinite(t)||Number(now)-t<ttl)continue;
    try{await alpaca(env,`/v2/orders/${o.id}`,{method:'DELETE'});out.push({action:'crypto_cancel_stale',symbol:o.symbol,clientOrderId:id});}catch(e){out.push({action:'crypto_cancel_stale_failed',symbol:o.symbol,reason:e.message});}
  }
  return out;
}

function cooldownSymbols(env,orders,now){
  const out=new Set(),baseMs=int(env.CRYPTO_REENTRY_COOLDOWN_MINUTES,20)*60000,stopMs=int(env.CRYPTO_HARDSTOP_REENTRY_COOLDOWN_MINUTES,60)*60000;
  for(const o of orders||[]){
    const id=String(o?.client_order_id||'');
    if(o?.side!=='sell'||o?.status!=='filled'||!id.startsWith('papercrypto-'))continue;
    const t=Date.parse(o?.filled_at||o?.submitted_at||'');
    if(!Number.isFinite(t))continue;
    const limit=id.includes('-sell-hardstop-')?stopMs:baseMs;
    if(Number(now)-t>=0&&Number(now)-t<=limit)out.add(norm(o.symbol));
  }
  return out;
}

function entryAgeMinutes(orders,symbol,now){
  const k=norm(symbol);
  for(const o of orders||[]){
    if(o?.side!=='buy'||o?.status!=='filled'||norm(o.symbol)!==k||!String(o?.client_order_id||'').startsWith('papercrypto-'))continue;
    const t=Date.parse(o?.filled_at||o?.submitted_at||'');
    if(Number.isFinite(t))return Math.max(0,(Number(now)-t)/60000);
  }
  return 999;
}

function currentStrategyOpenSymbols(orders){
  const inv={};
  for(const o of [...(orders||[])].filter(o=>String(o?.client_order_id||'').startsWith(CRYPTO_PREFIX)&&o?.status==='filled').sort((a,b)=>String(a.filled_at||a.submitted_at||'').localeCompare(String(b.filled_at||b.submitted_at||'')))){
    const k=norm(o.symbol),q=Math.abs(+o.filled_qty||0);if(!(q>0))continue;
    inv[k]=(inv[k]||0)+(o.side==='buy'?q:-q);
    if(inv[k]<1e-8)inv[k]=0;
  }
  return new Set(Object.entries(inv).filter(([,q])=>q>1e-8).map(([k])=>k));
}

function recoveryLossLock(env,orders,now){
  const lockMs=int(env.CRYPTO_RECOVERY_LOSS_COOLDOWN_MINUTES,180)*60000;
  for(const o of orders||[]){
    const id=String(o?.client_order_id||''),t=Date.parse(o?.filled_at||o?.submitted_at||'');
    if(o?.side!=='sell'||o?.status!=='filled'||!id.startsWith(CRYPTO_PREFIX)||!Number.isFinite(t))continue;
    if(!(id.includes('-sell-hardstop-')||id.includes('-sell-reversal-')))continue;
    const age=Number(now)-t;
    if(age>=0&&age<=lockMs)return{blocked:true,symbol:norm(o.symbol),minutesRemaining:Math.max(0,(lockMs-age)/60000)};
  }
  return{blocked:false,symbol:null,minutesRemaining:0};
}

function preliminaryCandidates(env,all){
  const fee=pct(env.CRYPTO_TAKER_FEE_PCT,0.0025)*2,expectedSlip=(pct(env.CRYPTO_MAX_ENTRY_SLIPPAGE_PCT,0.0015)+pct(env.CRYPTO_MAX_EXIT_SLIPPAGE_PCT,0.0015))*0.25,maxSpread=pct(env.CRYPTO_MAX_SPREAD_PCT,0.006);
  const minDaily=num(env.CRYPTO_MIN_DAILY_DOLLAR_VOLUME_USD,5000),minQuote=num(env.CRYPTO_MIN_QUOTE_NOTIONAL_USD,1000),minuteGate=pct(env.CRYPTO_MINUTE_MOMENTUM_PCT,0.0006),dayGate=pct(env.CRYPTO_DAY_MOMENTUM_PCT,0.012);
  return all.map(x=>{
    const shortMove=Math.max(0,x.minRet),dayMove=Math.max(0,x.dayRet),depthOrVolume=x.dollarVolume>=minDaily||x.quoteNotional>=minQuote,liquid=x.bid>0&&x.ask>0&&x.spread<=maxSpread&&depthOrVolume,highVelocity=shortMove>=minuteGate||dayMove>=dayGate;
    const mega=MEGA_CAPS.has(x.symbol),megaExceptional=shortMove>=0.008||dayMove>=0.08,activity=Math.max(10,x.dollarVolume,x.quoteNotional*10),velocity=shortMove*500+dayMove*6,discoveryBonus=mega?0:Math.min(2,shortMove*220+dayMove*4),megaPenalty=mega&&!megaExceptional?1.5:0;
    const roughProjected=Math.max(shortMove*3,dayMove*0.12),roughNet=roughProjected-(fee+expectedSlip+x.spread),roughScore=roughProjected*Math.log10(activity)*35+roughNet*180+velocity+discoveryBonus-megaPenalty;
    return{...x,roughScore,liquid,highVelocity,mega,megaExceptional};
  }).sort((a,b)=>b.roughScore-a.roughScore);
}

function researchCandidates(env,prelim,barsBySymbol){
  const fee=pct(env.CRYPTO_TAKER_FEE_PCT,0.0025)*2,fullSlip=pct(env.CRYPTO_MAX_ENTRY_SLIPPAGE_PCT,0.0015)+pct(env.CRYPTO_MAX_EXIT_SLIPPAGE_PCT,0.0015),minNet=pct(env.CRYPTO_MIN_EXPECTED_NET_EDGE_PCT,0.001),maxSpread=pct(env.CRYPTO_MAX_SPREAD_PCT,0.006);
  const min5=pct(env.CRYPTO_MIN_5M_MOMENTUM_PCT,0.0025),min15=pct(env.CRYPTO_MIN_15M_MOMENTUM_PCT,-0.001),minPositive=int(env.CRYPTO_MIN_POSITIVE_BARS_5,3),maxDay=pct(env.CRYPTO_MAX_DAY_CHASE_PCT,0.18);
  const evaluated=prelim.map(x=>{
    const r=barResearch(barsBySymbol[x.symbol]||[]),projectedMove=Math.max(Math.max(0,x.minRet)*2.5,Math.max(0,r.ret5)*1.35,Math.max(0,r.ret15)*0.45,Math.max(0,r.ret30)*0.25),cost=fee+fullSlip+x.spread,net=projectedMove-cost;
    const trendOk=r.historyOk&&r.ret5>=min5&&r.ret15>=min15&&r.positive5>=minPositive,antiChase=x.dayRet<maxDay&&r.ret5<0.04,pass=x.liquid&&x.highVelocity&&trendOk&&antiChase&&x.dayRet>-0.08&&x.spread<=maxSpread&&net>minNet;
    const activity=Math.max(10,x.dollarVolume,x.quoteNotional*10),volumeBonus=clamp((r.volumeExpansion-1)*0.25,-0.2,0.6),score=projectedMove*Math.log10(activity)*60+net*300+r.ret5*350+r.ret15*80+r.ret30*30+r.positive5*0.25+volumeBonus+(x.mega?-0.75:0);
    const reasons=[];
    if(!x.liquid)reasons.push('liquidity_or_spread');
    if(!x.highVelocity)reasons.push('velocity');
    if(!r.historyOk)reasons.push('research_unavailable');
    if(r.ret5<min5)reasons.push('5m_momentum');
    if(r.ret15<min15)reasons.push('15m_trend');
    if(r.positive5<minPositive)reasons.push('persistence');
    if(!antiChase)reasons.push('chase');
    if(x.dayRet<=-0.08)reasons.push('downtrend');
    if(net<=minNet)reasons.push('net_edge');
    return{...x,...r,projectedMove,cost,net,score,pass,reasons};
  }).sort((a,b)=>b.score-a.score);
  return{qualified:evaluated.filter(x=>x.pass),evaluated,researched:evaluated.slice(0,10)};
}

async function buildResearch(env,light,now){
  const prelim=preliminaryCandidates(env,light),shortlist=prelim.slice(0,int(env.CRYPTO_DEEP_RESEARCH_CANDIDATES,12)),bars=await recentBars(env,shortlist.map(x=>x.symbol),now);
  return researchCandidates(env,prelim,bars);
}

function sizingCaps(env,c,equity,cash,availableExposure){
  const configuredCap=Math.min(num(env.CRYPTO_ORDER_NOTIONAL_USD,25000),num(env.CRYPTO_MAX_POSITION_USD,25000)),targetFraction=clamp(0.18+c.score*0.004,0.18,0.25),bookParticipation=clamp(num(env.CRYPTO_MAX_BOOK_PARTICIPATION,0.20),0.05,0.35),dailyParticipation=clamp(num(env.CRYPTO_MAX_DAILY_VOLUME_PARTICIPATION,0.01),0.001,0.05),minQuote=num(env.CRYPTO_MIN_QUOTE_NOTIONAL_USD,1000);
  const depthCap=c.quoteNotional>0?c.quoteNotional*bookParticipation:0,volumeCap=c.dollarVolume>0?c.dollarVolume*dailyParticipation:0,depthUsable=c.quoteNotional>=minQuote,liquidityCap=depthUsable?depthCap:volumeCap,liquiditySource=depthUsable?'quote_depth':'venue_volume_fallback';
  const notional=Math.max(0,Math.min(configuredCap,equity*targetFraction,cash,availableExposure,liquidityCap));
  return{targetFraction,bookParticipation,dailyParticipation,depthCap,volumeCap,liquidityCap,liquiditySource,notional};
}

function recoveryQualifies(env,c){
  if(!c?.pass)return false;
  const min5=pct(env.CRYPTO_RECOVERY_MIN_5M_MOMENTUM_PCT,0.006),min15=pct(env.CRYPTO_RECOVERY_MIN_15M_MOMENTUM_PCT,0.008),minPositive=int(env.CRYPTO_RECOVERY_MIN_POSITIVE_BARS_5,4),minNet=pct(env.CRYPTO_RECOVERY_MIN_NET_EDGE_PCT,0.004),maxSpread=pct(env.CRYPTO_RECOVERY_MAX_SPREAD_PCT,0.004),minQuote=num(env.CRYPTO_RECOVERY_MIN_QUOTE_NOTIONAL_USD,10000),maxDay=pct(env.CRYPTO_RECOVERY_MAX_DAY_CHASE_PCT,0.12);
  return c.ret5>=min5&&c.ret15>=min15&&c.positive5>=minPositive&&c.net>=minNet&&c.spread<=maxSpread&&c.quoteNotional>=minQuote&&c.dayRet>0&&c.dayRet<maxDay&&c.minRet>-0.0015;
}

function recoverySizing(env,c,equity,cash,availableExposure){
  const fraction=clamp(pct(env.CRYPTO_RECOVERY_MAX_POSITION_PCT,0.06),0.02,0.10),bookParticipation=clamp(num(env.CRYPTO_RECOVERY_MAX_BOOK_PARTICIPATION,0.12),0.05,0.20),configuredCap=num(env.CRYPTO_RECOVERY_MAX_POSITION_USD,7500);
  const depthCap=Math.max(0,c.quoteNotional*bookParticipation),notional=Math.max(0,Math.min(configuredCap,equity*fraction,cash,availableExposure,depthCap));
  return{fraction,bookParticipation,depthCap,notional};
}

async function manage(env,now,allAssets,positions,orders,snap,ranked){
  const actions=[],byNorm=new Map(allAssets.map(a=>[norm(a.symbol),a])),byRank=new Map(ranked.map(x=>[norm(x.symbol),x])),best=ranked[0]||null,held=(positions||[]).filter(p=>byNorm.has(norm(p.symbol))&&Math.abs(+p.market_value||(+p.qty||0)*(+p.current_price||0))>1);
  const baseTarget=pct(env.CRYPTO_TAKE_PROFIT_PCT,0.0125),hardStopPct=pct(env.CRYPTO_HARD_STOP_PCT,0.012),minNetProfit=pct(env.CRYPTO_MIN_NET_PROFIT_PCT,0.004),minHold=int(env.CRYPTO_MIN_HOLD_MINUTES,5),maxSpread=pct(env.CRYPTO_MAX_SPREAD_PCT,0.006);
  const roundFee=pct(env.CRYPTO_TAKER_FEE_PCT,0.0025)*2,fullSlip=pct(env.CRYPTO_MAX_ENTRY_SLIPPAGE_PCT,0.0015)+pct(env.CRYPTO_MAX_EXIT_SLIPPAGE_PCT,0.0015),rotationFloor=roundFee+minNetProfit;
  for(const p of held){
    const asset=byNorm.get(norm(p.symbol)),s=asset.symbol,f=fields(snap[s]||{}),entry=+p.avg_entry_price||0,mark=+p.current_price||0,bid=f.bid>0?f.bid:mark,execPnl=entry>0&&bid>0?bid/entry-1:0,reportedPnl=Number(p.unrealized_plpc),age=entryAgeMinutes(orders,s,now);
    const current=byRank.get(norm(s)),currentScore=current?.score??-99,effectiveSpread=f.bid>0&&f.ask>0?Math.min(f.spread,maxSpread):Math.min(maxSpread,0.0025),dynamicTarget=Math.max(baseTarget,roundFee+fullSlip+effectiveSpread+minNetProfit);
    const hardStop=execPnl<=-hardStopPct,takeProfit=execPnl>=dynamicTarget,profitFade=age>=minHold&&execPnl>=Math.max(0.008,dynamicTarget*0.60)&&f.minRet<-0.0015;
    const reversal=age>=minHold&&execPnl<=-0.004&&f.minRet<-0.003,currentWeak=!current||current.ret5<0||current.positive5<2,stagnant=current?Math.abs(current.ret5)<0.0015:false,megaSlow=MEGA_CAPS.has(s)&&current&&!current.megaExceptional;
    const stronger=best&&norm(best.symbol)!==norm(s)&&best.score>currentScore+1.0,rotate=Boolean(age>=minHold&&stronger&&(stagnant||megaSlow||currentWeak)&&execPnl>=rotationFloor);
    if(hardStop||takeProfit||profitFade||rotate||reversal){
      const reason=hardStop?'hardstop':takeProfit?'takeprofit':profitFade?'profitfade':rotate?'rotate':'reversal',profitFloor=reason==='rotate'?rotationFloor:Math.max(0,roundFee+minNetProfit);
      try{const o=await sell(env,p,asset,bid,entry,now,reason,profitFloor);if(o)actions.push({action:'crypto_sell',symbol:s,reason:hardStop?'hard_stop_executable_bid':takeProfit?'executable_take_profit':profitFade?'profit_fade_after_min_hold':rotate?'profitable_rotation':'confirmed_reversal_after_min_hold',ageMinutes:round(age,2),execPnlPct:round(execPnl,5),reportedPnlPct:Number.isFinite(reportedPnl)?round(reportedPnl,5):null,targetPct:round(dynamicTarget,5),replacement:rotate?best?.symbol:null,orderType:o?.type||null,orderStatus:o?.status||null});}
      catch(e){actions.push({action:'crypto_sell_failed',symbol:s,reason:e.message});}
    }
  }
  return actions;
}

const diag=x=>({symbol:x.symbol,pass:x.pass,minuteMove:round(x.minRet,5),fiveMinuteMove:round(x.ret5||0,5),fifteenMinuteMove:round(x.ret15||0,5),thirtyMinuteMove:round(x.ret30||0,5),positiveBars5:x.positive5||0,volumeExpansion:round(x.volumeExpansion||0,3),dayMove:round(x.dayRet,5),spread:round(x.spread,5),dailyDollarVolume:round(x.dollarVolume,2),quoteNotional:round(x.quoteNotional,2),projectedMove:round(x.projectedMove||0,5),net:round(x.net||0,5),score:round(x.score||x.roughScore||0,4),reasons:x.reasons||[]});

function drawdownState(env,account){
  const equity=+(account.equity||account.portfolio_value||0),last=+(account.last_equity||0),drawdown=last>0?equity/last-1:0,max=pct(env.CRYPTO_MAX_DAILY_DRAWDOWN_PCT,0.02);
  return{drawdown,max,blocked:last>0&&drawdown<=-max};
}

export async function cryptoOpportunityDiagnostics(env,now=Date.now()){
  const allAssets=await assets(env),symbols=allAssets.map(a=>a.symbol),[positions,account,orders]=await Promise.all([alpaca(env,'/v2/positions'),alpaca(env,'/v2/account'),alpaca(env,'/v2/orders?status=all&limit=250&direction=desc&nested=false')]);
  const sn=symbols.length?await snapshots(env,symbols):{},light=symbols.map(symbol=>({symbol,...fields(sn[symbol]||{})})),{qualified,evaluated}=await buildResearch(env,light,now),byNorm=new Map(allAssets.map(a=>[norm(a.symbol),a]));
  const held=(positions||[]).filter(p=>byNorm.has(norm(p.symbol))&&Math.abs(+p.market_value||(+p.qty||0)*(+p.current_price||0))>1),heldSet=new Set(held.map(p=>norm(p.symbol))),cooldowns=cooldownSymbols(env,orders,now),maxPos=int(env.CRYPTO_MAX_CONCURRENT_POSITIONS,2),dd=drawdownState(env,account),currentOpen=currentStrategyOpenSymbols(orders),lossLock=recoveryLossLock(env,orders,now),recoveryEnabled=String(env.CRYPTO_RECOVERY_MODE_ENABLED??'true')==='true';
  const cash=Math.max(0,+(account.non_marginable_buying_power||account.cash||account.buying_power||0)),equity=Math.max(cash,+(account.equity||account.portfolio_value||0)),configuredTotalCap=num(env.CRYPTO_MAX_TOTAL_EXPOSURE_USD,50000),currentExposure=held.reduce((z,p)=>z+Math.abs(+p.market_value||(+p.qty||0)*(+p.current_price||0)),0),totalCap=Math.min(configuredTotalCap,equity*0.50),availableExposure=Math.max(0,totalCap-currentExposure),minOrder=num(env.CRYPTO_MIN_ORDER_NOTIONAL_USD,25);
  const ranked=evaluated.slice(0,12).map(c=>{
    const s=sizingCaps(env,c,equity,cash,availableExposure),r=recoverySizing(env,c,equity,cash,availableExposure),blocks=[...c.reasons];
    if(heldSet.has(norm(c.symbol)))blocks.push('already_held');if(cooldowns.has(norm(c.symbol)))blocks.push('reentry_cooldown');if(held.length>=maxPos)blocks.push('max_positions');if(dd.blocked)blocks.push('daily_drawdown_circuit_breaker');if(s.notional<minOrder)blocks.push('order_below_min_after_liquidity_cap');
    const recoveryPass=recoveryEnabled&&dd.blocked&&recoveryQualifies(env,c)&&!heldSet.has(norm(c.symbol))&&!cooldowns.has(norm(c.symbol))&&currentOpen.size===0&&!lossLock.blocked&&r.notional>=minOrder;
    return{...diag(c),bid:round(c.bid,8),ask:round(c.ask,8),targetEquityNotional:round(equity*s.targetFraction,2),depthCap:round(s.depthCap,2),liquiditySource:s.liquiditySource,liquidityCap:round(s.liquidityCap,2),finalOrderNotional:round(s.notional,2),cooldown:cooldowns.has(norm(c.symbol)),eligible:c.pass&&!heldSet.has(norm(c.symbol))&&!cooldowns.has(norm(c.symbol))&&held.length<maxPos&&!dd.blocked&&s.notional>=minOrder,recoveryEligible:recoveryPass,recoveryOrderNotional:round(r.notional,2),blocks:[...new Set(blocks)]};
  });
  return{strategy:CRYPTO_STRATEGY,readOnly:true,universeCount:symbols.length,qualifiedCount:qualified.length,equity:round(equity,2),cash:round(cash,2),currentExposure:round(currentExposure,2),availableExposure:round(availableExposure,2),maxPositions:maxPos,heldSymbols:[...heldSet],cooldownSymbols:[...cooldowns],dailyDrawdownPct:round(dd.drawdown,5),dailyDrawdownLimitPct:round(dd.max,5),dailyDrawdownBlocked:dd.blocked,recoveryModeEnabled:recoveryEnabled,recoveryModeActive:recoveryEnabled&&dd.blocked,recoveryLossLocked:lossLock.blocked,recoveryLossCooldownMinutesRemaining:round(lossLock.minutesRemaining,1),currentV22OpenSymbols:[...currentOpen],liquiditySizingPolicy:'quote_depth_first_venue_volume_fallback',candidates:ranked};
}

export async function runCryptoFreeTier(env,now,{discover=true}={}){
  const allAssets=await assets(env),symbols=allAssets.map(a=>a.symbol),[positions,account,orders]=await Promise.all([alpaca(env,'/v2/positions'),alpaca(env,'/v2/account'),alpaca(env,'/v2/orders?status=all&limit=250&direction=desc&nested=false')]);
  if(!symbols.length)return{status:'hold',strategy:CRYPTO_STRATEGY,mode:'multitimeframe_velocity_rank',reason:'no_tradable_usd_crypto'};
  const staleActions=await cancelStaleOrders(env,orders,now),sn=await snapshots(env,symbols),light=symbols.map(symbol=>({symbol,...fields(sn[symbol]||{})})),{qualified,researched}=await buildResearch(env,light,now),finalists=qualified.slice(0,int(env.FREE_TIER_CRYPTO_FINALISTS,6)),actions=[...staleActions,...await manage(env,now,allAssets,positions,orders,sn,qualified)];
  if(!discover)return{status:actions.length?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'manage_only',actions};

  const byNorm=new Map(allAssets.map(a=>[norm(a.symbol),a])),held=(positions||[]).filter(p=>byNorm.has(norm(p.symbol))&&Math.abs(+p.market_value||(+p.qty||0)*(+p.current_price||0))>1),heldSet=new Set(held.map(p=>norm(p.symbol))),maxPos=int(env.CRYPTO_MAX_CONCURRENT_POSITIONS,2),dd=drawdownState(env,account),cooldowns=cooldownSymbols(env,orders,now),cash=Math.max(0,+(account.non_marginable_buying_power||account.cash||account.buying_power||0)),equity=Math.max(cash,+(account.equity||account.portfolio_value||0)),configuredTotalCap=num(env.CRYPTO_MAX_TOTAL_EXPOSURE_USD,50000),currentExposure=held.reduce((z,p)=>z+Math.abs(+p.market_value||(+p.qty||0)*(+p.current_price||0)),0),totalCap=Math.min(configuredTotalCap,equity*0.50),availableExposure=Math.max(0,totalCap-currentExposure),minOrder=num(env.CRYPTO_MIN_ORDER_NOTIONAL_USD,25);

  if(dd.blocked){
    const recoveryEnabled=String(env.CRYPTO_RECOVERY_MODE_ENABLED??'true')==='true',currentOpen=currentStrategyOpenSymbols(orders),lossLock=recoveryLossLock(env,orders,now),c=finalists.find(x=>recoveryQualifies(env,x)&&!heldSet.has(norm(x.symbol))&&!cooldowns.has(norm(x.symbol)));
    if(!recoveryEnabled||currentOpen.size>0||lossLock.blocked||!c)return{status:actions.length?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'risk_recovery_wait',reason:!recoveryEnabled?'recovery_disabled':currentOpen.size>0?'recovery_position_already_open':lossLock.blocked?'recovery_loss_cooldown':'no_high_conviction_recovery_setup',dailyDrawdownPct:round(dd.drawdown,5),dailyDrawdownLimitPct:round(dd.max,5),recoveryLossCooldownMinutesRemaining:round(lossLock.minutesRemaining,1),qualified:finalists.map(diag),researched:researched.map(diag),actions};
    const r=recoverySizing(env,c,equity,cash,availableExposure),asset=byNorm.get(norm(c.symbol));
    if(r.notional<minOrder)return{status:actions.length?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'risk_recovery_wait',reason:'recovery_liquidity_too_thin',candidate:diag(c),recoveryOrderNotional:round(r.notional,2),actions};
    try{const o=await buy(env,c,asset,r.notional,now,'recovery');if(o)actions.push({action:'crypto_buy',symbol:c.symbol,reason:'v22_recovery_high_conviction',minuteMove:round(c.minRet,5),fiveMinuteMove:round(c.ret5,5),fifteenMinuteMove:round(c.ret15,5),thirtyMinuteMove:round(c.ret30,5),positiveBars5:c.positive5,dayMove:round(c.dayRet,5),expectedNetEdge:round(c.net,5),score:round(c.score,4),recoveryMode:true,equityFraction:round(r.fraction,4),bookParticipation:round(r.bookParticipation,4),depthCap:round(r.depthCap,2),notional:round(r.notional,2),orderStatus:o?.status||null,orderType:o?.type||null});}
    catch(e){actions.push({action:'crypto_buy_failed',symbol:c.symbol,reason:e.message,recoveryMode:true});}
    return{status:actions.some(a=>a.action==='crypto_buy'||a.action==='crypto_sell')?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'controlled_recovery',dailyDrawdownPct:round(dd.drawdown,5),dailyDrawdownLimitPct:round(dd.max,5),qualified:finalists.map(diag),actions};
  }

  if(held.length>=maxPos||!finalists.length)return{status:actions.length?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'multitimeframe_velocity_rank',universeCount:symbols.length,qualified:finalists.map(diag),researched:researched.map(diag),actions};
  const c=finalists.find(x=>!heldSet.has(norm(x.symbol))&&!cooldowns.has(norm(x.symbol)));
  if(!c)return{status:actions.length?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'multitimeframe_velocity_rank',universeCount:symbols.length,qualified:finalists.map(diag),researched:researched.map(diag),cooldownSymbols:[...cooldowns],actions};
  const s=sizingCaps(env,c,equity,cash,availableExposure),asset=byNorm.get(norm(c.symbol));
  if(s.notional>=minOrder){
    try{const o=await buy(env,c,asset,s.notional,now,'mtf');if(o)actions.push({action:'crypto_buy',symbol:c.symbol,reason:'v22_multitimeframe_persistent_velocity',minuteMove:round(c.minRet,5),fiveMinuteMove:round(c.ret5,5),fifteenMinuteMove:round(c.ret15,5),thirtyMinuteMove:round(c.ret30,5),positiveBars5:c.positive5,dayMove:round(c.dayRet,5),expectedNetEdge:round(c.net,5),score:round(c.score,4),equityFraction:round(s.targetFraction,4),liquiditySource:s.liquiditySource,notional:round(s.notional,2),orderStatus:o?.status||null,orderType:o?.type||null});}
    catch(e){actions.push({action:'crypto_buy_failed',symbol:c.symbol,reason:e.message});}
  }else actions.push({action:'crypto_buy_skipped',symbol:c.symbol,reason:'insufficient_executable_liquidity_for_min_order',liquiditySource:s.liquiditySource,liquidityCap:round(s.liquidityCap,2)});
  return{status:actions.some(a=>a.action==='crypto_buy'||a.action==='crypto_sell')?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'multitimeframe_velocity_rank',universeCount:symbols.length,qualified:finalists.map(diag),researched:researched.map(diag),cooldownSymbols:[...cooldowns],actions};
}

export function cryptoFreeTierStatus(env){
  return{strategy:CRYPTO_STRATEGY,endpoint:'paper',market:'24x7',entryOrderType:'protected_limit_ioc',hardStopExitOrderType:'market',profitExitOrderType:'protected_limit_ioc',positionPnlSource:'executable_bid_only',liquiditySizingPolicy:'quote_depth_first_venue_volume_fallback',freeTier:{cpuMsPerInvocation:10,requestLimitPerDay:100000,architecture:'all_tradable_usd_crypto_multitimeframe_velocity_rank',finalists:int(env.FREE_TIER_CRYPTO_FINALISTS,6),alternatingMarketDiscovery:false},research:{allActiveTradablePairs:true,stablecoinsExcluded:true,fullExecutableUsdUniverse:true,percentageVelocityPriority:true,multiTimeframeConfirmation:true,persistenceConfirmation:true,thirtyMinuteContext:true,volumeExpansionResearch:false,megaCapDeprioritization:true,quoteDepthLiquidity:true,venueVolumeFallbackLiquidity:true,candidateDiagnostics:true,staleOrderCancellation:true,hardStopExecutableOnly:true,singleMinuteExitDisabled:true,minHoldBeforeNoiseExit:true,rotationRequiresNetProfit:true,dailyDrawdownCircuitBreaker:true,controlledRecoveryMode:true,recoveryLossLockout:true,recoveryRequiresHighConviction:true,qualityOverTurnover:true,liquidityAwarePositionSizing:true,equityScaledPositionSizing:true,maxPortfolioExposurePct:0.50,timeframes:['1Min','5Min','15Min','30Min','1Day'],crossSectionRelativeStrength:true,researchBeforeExecution:true,tradeVolumeObjective:false,antiChaseEntryTiming:true},takeProfitPct:pct(env.CRYPTO_TAKE_PROFIT_PCT,0.0125),minHoldMinutes:int(env.CRYPTO_MIN_HOLD_MINUTES,5),reentryCooldownMinutes:int(env.CRYPTO_REENTRY_COOLDOWN_MINUTES,20),hardStopReentryCooldownMinutes:int(env.CRYPTO_HARDSTOP_REENTRY_COOLDOWN_MINUTES,60),dailyDrawdownLimitPct:pct(env.CRYPTO_MAX_DAILY_DRAWDOWN_PCT,0.02),recoveryModeEnabled:String(env.CRYPTO_RECOVERY_MODE_ENABLED??'true')==='true',recoveryMaxPositionPct:pct(env.CRYPTO_RECOVERY_MAX_POSITION_PCT,0.06),recoveryLossCooldownMinutes:int(env.CRYPTO_RECOVERY_LOSS_COOLDOWN_MINUTES,180),recoveryMin5mPct:pct(env.CRYPTO_RECOVERY_MIN_5M_MOMENTUM_PCT,0.006),recoveryMin15mPct:pct(env.CRYPTO_RECOVERY_MIN_15M_MOMENTUM_PCT,0.008),recoveryMinNetEdgePct:pct(env.CRYPTO_RECOVERY_MIN_NET_EDGE_PCT,0.004),maxBookParticipation:clamp(num(env.CRYPTO_MAX_BOOK_PARTICIPATION,0.20),0.05,0.35),maxDailyVolumeParticipation:clamp(num(env.CRYPTO_MAX_DAILY_VOLUME_PARTICIPATION,0.01),0.001,0.05)};
}

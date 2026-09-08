import { alpaca, marketDataRaw } from './api.js';
import { num, pct, int, clamp, round } from './config.js';
import { confirmCoinbaseMomentum } from './coinbase-confirm.js';

export const CRYPTO_STRATEGY = 'quant-crypto-v24';
export const CRYPTO_PREFIX = 'papercrypto-v24-';

const STABLES = new Set(['USDC/USD','USDT/USD','USDG/USD','DAI/USD']);
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
const cid = (side,symbol,now,tag) => `${CRYPTO_PREFIX}${side}-${tag}-${norm(symbol)}-${Number(now).toString(36)}`.slice(0,48);

let assetCache = { at:0, assets:[] };

async function assets(env){
  if(assetCache.assets.length && Date.now()-assetCache.at < 300000) return assetCache.assets;
  const a = await alpaca(env,'/v2/assets?status=active&asset_class=crypto');
  const xs = (Array.isArray(a)?a:[]).filter(x =>
    x?.symbol && x.tradable !== false && x.status !== 'inactive' &&
    String(x.symbol).endsWith('/USD') && !STABLES.has(String(x.symbol).toUpperCase())
  );
  if(xs.length) assetCache = { at:Date.now(), assets:xs };
  return assetCache.assets;
}

async function snapshots(env,symbols){
  if(!symbols.length) return {};
  const d = await marketDataRaw(env,`/v1beta3/crypto/us/snapshots?symbols=${symbols.map(encodeURIComponent).join(',')}`);
  return d?.snapshots || d || {};
}

async function bars(env,symbols,timeframe,startMs,limit=10000){
  if(!symbols.length) return {};
  const start = new Date(startMs).toISOString();
  const d = await marketDataRaw(env,`/v1beta3/crypto/us/bars?symbols=${symbols.map(encodeURIComponent).join(',')}&timeframe=${encodeURIComponent(timeframe)}&start=${encodeURIComponent(start)}&limit=${limit}&sort=asc`);
  return d?.bars || {};
}

function fields(s={}){
  const q=s.latestQuote||s.latest_quote||{},m=s.minuteBar||s.minute_bar||{},d=s.dailyBar||s.daily_bar||{},p=s.prevDailyBar||s.prev_daily_bar||{};
  const bid=+(q.bp??q.bid_price??0),ask=+(q.ap??q.ask_price??0),bidSize=+(q.bs??q.bid_size??0),askSize=+(q.as??q.ask_size??0);
  const mid=bid>0&&ask>0?(bid+ask)/2:+(m.c??m.close??d.c??d.close??0);
  const spread=mid>0&&ask>=bid?(ask-bid)/mid:1;
  const dc=+(d.c??d.close??mid),vol=+(d.v??d.volume??0);
  return {
    bid,ask,bidSize,askSize,mid,spread,
    quoteNotional:Math.max(0,Math.min(bid*bidSize,ask*askSize)),
    dailyDollarVolume:Math.max(0,dc*vol)
  };
}

const close = x => +(x?.c??x?.close??0);
const high = x => +(x?.h??x?.high??0);
const low = x => +(x?.l??x?.low??0);
const open = x => +(x?.o??x?.open??0);
const volume = x => Math.max(0,+(x?.v??x?.volume??0));

function ema(values,period){
  if(!values.length) return 0;
  const k=2/(period+1);
  let e=values[0];
  for(let i=1;i<values.length;i++) e=values[i]*k+e*(1-k);
  return e;
}

function rsi(values,period=14){
  if(values.length<period+1) return 50;
  let gains=0,losses=0;
  for(let i=values.length-period;i<values.length;i++){
    const d=values[i]-values[i-1];
    if(d>0) gains+=d; else losses-=d;
  }
  if(losses<=0) return gains>0?100:50;
  const rs=(gains/period)/(losses/period);
  return 100-(100/(1+rs));
}

function aggregate5m(xs=[]){
  const map=new Map();
  for(const x of xs){
    const t=Date.parse(x?.t??x?.timestamp??'');
    if(!Number.isFinite(t)||!(close(x)>0)) continue;
    const k=Math.floor(t/300000)*300000;
    let b=map.get(k);
    if(!b){b={t:k,o:open(x)||close(x),h:high(x)||close(x),l:low(x)||close(x),c:close(x),v:volume(x)};map.set(k,b);}
    else{b.h=Math.max(b.h,high(x)||close(x));b.l=Math.min(b.l,low(x)||close(x));b.c=close(x);b.v+=volume(x);}
  }
  return [...map.values()].sort((a,b)=>a.t-b.t);
}

function atrPct(xs=[],period=14){
  if(xs.length<period+1) return 0;
  let sum=0,n=0;
  for(let i=xs.length-period;i<xs.length;i++){
    const prev=close(xs[i-1]),h=high(xs[i]),l=low(xs[i]);
    if(!(prev>0&&h>0&&l>0)) continue;
    sum += Math.max(h-l,Math.abs(h-prev),Math.abs(l-prev));
    n++;
  }
  const p=close(xs[xs.length-1]);
  return n&&p>0?(sum/n)/p:0;
}

function localResearch(arr=[]){
  const xs=(Array.isArray(arr)?arr:[]).filter(x=>close(x)>0);
  const prices=xs.map(close);
  const ret=n=>{
    if(xs.length<=n) return 0;
    const a=close(xs[xs.length-1-n]),b=close(xs[xs.length-1]);
    return a>0?b/a-1:0;
  };
  const five=aggregate5m(xs);
  const fp=five.map(close);
  const ema9=ema(fp.slice(-30),9);
  const ema12=ema(fp.slice(-40),12),ema26=ema(fp.slice(-60),26);
  const macd=ema12-ema26;
  const macdSeries=[];
  for(let i=Math.max(26,fp.length-20);i<=fp.length;i++){
    const sub=fp.slice(0,i);
    if(sub.length>=26) macdSeries.push(ema(sub,12)-ema(sub,26));
  }
  const signal=ema(macdSeries,9),hist=macd-signal;
  const last=xs[xs.length-1],price=close(last);
  return {
    historyOk:xs.length>=61,
    barCount:xs.length,
    ret1:ret(1),ret5:ret(5),ret15:ret(15),ret60:ret(60),
    rsi14_5m:rsi(fp,14),
    macdHist5m:hist,
    ema9_5m:ema9,
    atrPct5m:atrPct(five,14),
    price
  };
}

async function portfolioDrawdown(env,account,now){
  const max=pct(env.CRYPTO_MAX_DAILY_DRAWDOWN_PCT,0.03),freezeHours=Math.max(1,num(env.CRYPTO_BREAKER_FREEZE_HOURS,4));
  let history=null;
  try{history=await alpaca(env,'/v2/account/portfolio/history?period=1D&timeframe=5Min&intraday_reporting=continuous&pnl_reset=no_reset');}catch{}
  const eq=Array.isArray(history?.equity)?history.equity.map(Number):[];
  const ts=Array.isArray(history?.timestamp)?history.timestamp.map(x=>Number(x)*1000):[];
  const current=+(account.equity||account.portfolio_value||0);
  if(!eq.length||eq.length!==ts.length){
    const last=+(account.last_equity||0),dd=last>0?current/last-1:0;
    return{drawdown:dd,max,blocked:dd<=-max,breachAt:null,freezeHours,source:'account_last_equity'};
  }
  let peak=0,lastBreach=null,inBreach=false;
  for(let i=0;i<eq.length;i++){
    const e=eq[i];
    if(!(e>0)) continue;
    peak=Math.max(peak,e);
    const d=peak>0?e/peak-1:0;
    if(d<=-max&&!inBreach){lastBreach=ts[i];inBreach=true;}
    if(d>-max*0.5) inBreach=false;
  }
  peak=Math.max(peak,current);
  const drawdown=peak>0?current/peak-1:0;
  const blocked=Number.isFinite(lastBreach)&&Number(now)-lastBreach<freezeHours*3600000;
  return{drawdown,max,blocked,breachAt:lastBreach?new Date(lastBreach).toISOString():null,freezeHours,source:'rolling_24h_peak'};
}

function historicalPerf(arr=[],stopPct=0.01,currentAtrPct=0.01){
  const xs=(Array.isArray(arr)?arr:[]).filter(x=>close(x)>0);
  let trades=0,wins=0,grossWinR=0,grossLossR=0;
  const atrAt=i=>{
    if(i<15) return 0;
    return atrPct(xs.slice(0,i+1),14);
  };
  for(let i=30;i<xs.length-12;i+=2){
    const p=close(xs[i]),p3=close(xs[i-3]),p12=close(xs[i-12]);
    if(!(p>0&&p3>0&&p12>0)) continue;
    const ret15=p/p3-1,ret60=p/p12-1;
    if(!(ret15>0&&ret60>0)) continue;
    const a=atrAt(i);
    if(currentAtrPct>0 && !(a>=currentAtrPct*0.5 && a<=currentAtrPct*1.75)) continue;
    const recentVol=xs.slice(i-2,i+1).reduce((z,x)=>z+volume(x),0)/3;
    const baseVol=xs.slice(i-14,i-2).reduce((z,x)=>z+volume(x),0)/12;
    if(baseVol>0 && recentVol/baseVol<1.5) continue;
    trades++;
    const stop=p*(1-stopPct),target=p*(1+2*stopPct);
    let r=null;
    for(let j=i+1;j<=i+12;j++){
      if(low(xs[j])<=stop){r=-1;break;}
      if(high(xs[j])>=target){r=2;break;}
    }
    if(r===null) r=clamp((close(xs[i+12])/p-1)/Math.max(stopPct,1e-6),-1,2);
    if(r>0){wins++;grossWinR+=r;}else grossLossR+=Math.abs(r);
  }
  return {
    trades,
    winRate:trades?wins/trades:0,
    profitFactor:grossLossR>0?grossWinR/grossLossR:(grossWinR>0?99:0)
  };
}

function alphaScore(env,c,x,h){
  const minVol=num(env.CRYPTO_MIN_24H_DOLLAR_VOLUME_USD,10000000);
  const minDepth=num(env.CRYPTO_MIN_DEPTH_WITHIN_20BPS_USD,50000);
  const maxSpread=pct(env.CRYPTO_MAX_EXECUTION_SPREAD_PCT,0.0005);
  const minRvol15=num(env.CRYPTO_MIN_RVOL_15,2.5),minRvol60=num(env.CRYPTO_MIN_RVOL_60,2.5);
  const minAtr=num(env.CRYPTO_MIN_ATR_EXPANSION,1.05),minBb=num(env.CRYPTO_MIN_BB_EXPANSION,1.05);
  const minTaker=num(env.CRYPTO_MIN_TAKER_BUY_RATIO,1.8),minImb=num(env.CRYPTO_MIN_ORDERBOOK_IMBALANCE,0.55);
  const histWr=num(env.CRYPTO_HISTORICAL_MIN_WIN_RATE,0.60),histPf=num(env.CRYPTO_HISTORICAL_MIN_PROFIT_FACTOR,2.0);
  let s=0;
  s += x.dollarVolume24>=minVol?5:5*clamp(x.dollarVolume24/minVol,0,1);
  s += x.depthWithin20bps>=minDepth?7:7*clamp(x.depthWithin20bps/minDepth,0,1);
  s += Math.max(c.spread,x.spread)<=maxSpread?4:0;
  s += c.quoteNotional>=num(env.CRYPTO_EXECUTION_MIN_TOP_QUOTE_NOTIONAL_USD,5000)?4:0;

  s += c.ret5>0?4:0;
  s += c.ret15>0?4:0;
  s += c.ret60>0?4:0;
  s += x.price>x.vwap24?4:0;
  s += c.rsi14_5m>=50&&c.rsi14_5m<=72?4:0;
  s += c.macdHist5m>0?5:0;

  s += 5*clamp(x.rvol15/minRvol15,0,1);
  s += 4*clamp(x.rvol60/minRvol60,0,1);
  s += 3*clamp(x.atrExpansion/minAtr,0,1);
  s += 3*clamp(x.bbWidthExpansion/minBb,0,1);

  s += 7*clamp(x.aggressiveBuySellRatio/minTaker,0,1);
  s += 6*clamp((x.orderBookImbalance-0.5)/Math.max(0.01,minImb-0.5),0,1);
  s += x.cvdUsd>0?7:0;

  s += 8*clamp(h.winRate/histWr,0,1);
  s += 7*clamp(h.profitFactor/histPf,0,1);

  s += x.priceDivergence<=pct(env.CRYPTO_MAX_CROSS_VENUE_PRICE_DIVERGENCE_PCT,0.005)?5:0;
  return clamp(s,0,100);
}

function gateReasons(env,c,x,h,score){
  const reasons=[];
  if(!(c.ret5>0&&c.ret15>0&&c.ret60>0)) reasons.push('positive_velocity_5m_15m_60m');
  if(Math.max(c.spread,x.spread)>pct(env.CRYPTO_MAX_EXECUTION_SPREAD_PCT,0.0005)) reasons.push('spread');
  if(c.quoteNotional<num(env.CRYPTO_EXECUTION_MIN_TOP_QUOTE_NOTIONAL_USD,5000)) reasons.push('alpaca_top_quote_depth');
  if(!x.pass) reasons.push(...(x.reasons||[]));
  if(h.trades<int(env.CRYPTO_HISTORICAL_MIN_TRADES,10)) reasons.push('historical_sample');
  if(h.trades>=int(env.CRYPTO_HISTORICAL_MIN_TRADES,10)&&h.winRate<num(env.CRYPTO_HISTORICAL_MIN_WIN_RATE,0.60)) reasons.push('historical_win_rate');
  if(h.trades>=int(env.CRYPTO_HISTORICAL_MIN_TRADES,10)&&h.profitFactor<num(env.CRYPTO_HISTORICAL_MIN_PROFIT_FACTOR,2.0)) reasons.push('historical_profit_factor');
  if(score<num(env.CRYPTO_ALPHA_MIN_SCORE,85)) reasons.push('alpha_score');
  return [...new Set(reasons)];
}

function stopPctFor(env,c,x){
  const atr=Math.max(c.atrPct5m||0,x.atrPct5m||0);
  return clamp(atr*1.5,pct(env.CRYPTO_MIN_STRUCTURAL_STOP_PCT,0.004),pct(env.CRYPTO_MAX_STRUCTURAL_STOP_PCT,0.03));
}

function sizing(env,equity,cash,availableExposure,c,x,h,currentValue=0){
  const stopPct=stopPctFor(env,c,x),payoff=2;
  const p=clamp((h.winRate||0.60)*0.70+(c.alphaConfidenceScore/100)*0.30,0.51,0.85);
  const quarterKelly=Math.max(0,((p*(payoff+1)-1)/payoff)*0.25);
  const scoreCap=clamp(pct(env.CRYPTO_RISK_MIN_PCT,0.01)+Math.max(0,c.alphaConfidenceScore-85)/15*(pct(env.CRYPTO_RISK_MAX_PCT,0.015)-pct(env.CRYPTO_RISK_MIN_PCT,0.01)),pct(env.CRYPTO_RISK_MIN_PCT,0.01),pct(env.CRYPTO_RISK_MAX_PCT,0.015));
  const riskPct=Math.min(quarterKelly,scoreCap),riskDollars=equity*riskPct;
  const riskTarget=stopPct>0?riskDollars/stopPct:0;
  const configuredCap=Math.min(num(env.CRYPTO_ORDER_NOTIONAL_USD,100000),num(env.CRYPTO_MAX_POSITION_USD,100000));
  const targetNotional=Math.max(0,Math.min(riskTarget,configuredCap,cash+currentValue,availableExposure+currentValue));
  const depthSide=Math.max(0,x.askDepthWithin20bps||x.depthWithin20bps/2);
  const sliceCap=depthSide*clamp(num(env.CRYPTO_TWAP_SLICE_BOOK_PCT,0.05),0.01,0.05);
  const remaining=Math.max(0,targetNotional-currentValue);
  const sliceNotional=Math.max(0,Math.min(remaining,sliceCap,Math.max(0,cash)));
  return{p,payoff,quarterKelly,riskPct,riskDollars,stopPct,targetNotional,sliceCap,sliceNotional,currentValue};
}

function fmtPrice(price,asset,ceil=true){
  const inc=Math.max(1e-12,+(asset?.price_increment||0.00000001));
  const u=ceil?Math.ceil(price/inc):Math.floor(price/inc);
  return String(Math.max(inc,u*inc));
}

function fmtQty(qty,asset){
  const inc=Math.max(1e-12,+(asset?.min_trade_increment||asset?.min_order_size||0.00000001));
  return String(Math.max(0,Math.floor((qty+inc*1e-8)/inc)*inc));
}

async function buySlice(env,c,asset,notional,now,tag){
  if(!(c.ask>0&&notional>0)) return null;
  const limit=+(fmtPrice(c.ask*(1+pct(env.CRYPTO_ENTRY_LIMIT_BUFFER_PCT,0.0003)),asset,true));
  const qty=fmtQty(notional/limit,asset);
  if(!(Number(qty)>0)) return null;
  return alpaca(env,'/v2/orders',{method:'POST',body:JSON.stringify({
    symbol:c.symbol,qty,side:'buy',type:'limit',limit_price:String(limit),time_in_force:'ioc',
    client_order_id:cid('buy',c.symbol,now,tag)
  })});
}

async function sellQty(env,p,asset,qty,bid,now,reason,limitProtected=false){
  const q=fmtQty(qty,asset);
  if(!(Number(q)>0)) return null;
  if(limitProtected&&bid>0){
    const lim=fmtPrice(bid*(1-pct(env.CRYPTO_PROFIT_EXIT_PRICE_BUFFER_PCT,0.0002)),asset,false);
    return alpaca(env,'/v2/orders',{method:'POST',body:JSON.stringify({
      symbol:asset.symbol,qty:q,side:'sell',type:'limit',limit_price:lim,time_in_force:'ioc',
      client_order_id:cid('sell',asset.symbol,now,reason)
    })});
  }
  return alpaca(env,'/v2/orders',{method:'POST',body:JSON.stringify({
    symbol:asset.symbol,qty:q,side:'sell',type:'market',time_in_force:'gtc',
    client_order_id:cid('sell',asset.symbol,now,reason)
  })});
}

function cycleState(orders,symbol){
  const k=norm(symbol),xs=(orders||[]).filter(o=>norm(o.symbol)===k&&String(o.client_order_id||'').startsWith(CRYPTO_PREFIX)&&o.status==='filled')
    .sort((a,b)=>String(a.filled_at||a.submitted_at||'').localeCompare(String(b.filled_at||b.submitted_at||'')));
  let inv=0,openedAt=null,tp1Done=false;
  for(const o of xs){
    const q=Math.abs(+o.filled_qty||0);
    if(!(q>0)) continue;
    if(o.side==='buy'){
      if(inv<=1e-8){openedAt=Date.parse(o.filled_at||o.submitted_at||'');tp1Done=false;}
      inv+=q;
    }else{
      if(String(o.client_order_id||'').includes('-sell-tp1-')) tp1Done=true;
      inv=Math.max(0,inv-q);
      if(inv<=1e-8){openedAt=null;tp1Done=false;}
    }
  }
  return{open:inv>1e-8,qty:inv,openedAt,tp1Done};
}

function openOrderSymbols(orders){
  return new Set((orders||[]).filter(o=>String(o.client_order_id||'').startsWith(CRYPTO_PREFIX)&&['new','accepted','pending_new','partially_filled'].includes(String(o.status||'').toLowerCase())).map(o=>norm(o.symbol)));
}

async function cancelStaleOrders(env,orders,now){
  const actions=[],ttl=int(env.CRYPTO_STALE_ORDER_SECONDS,90)*1000;
  for(const o of orders||[]){
    if(!String(o.client_order_id||'').startsWith(CRYPTO_PREFIX)) continue;
    if(!['new','accepted','pending_new','partially_filled'].includes(String(o.status||'').toLowerCase())) continue;
    const t=Date.parse(o.submitted_at||'');
    if(!Number.isFinite(t)||Number(now)-t<ttl) continue;
    try{await alpaca(env,`/v2/orders/${o.id}`,{method:'DELETE'});actions.push({action:'crypto_cancel_stale',symbol:o.symbol});}catch{}
  }
  return actions;
}

async function correlationGuard(env,candidate,heldSymbols,now){
  if(!candidate||heldSymbols.length<2) return{blocked:false,maxCorrelation:0,correlatedCount:0};
  const syms=[candidate,...heldSymbols];
  let data={};
  try{data=await bars(env,syms,'1Hour',Number(now)-26*3600000,1000);}catch{return{blocked:true,reason:'correlation_data_unavailable',maxCorrelation:1,correlatedCount:heldSymbols.length};}
  const returns=s=>{
    const xs=(data[s]||[]).filter(x=>close(x)>0),out=[];
    for(let i=1;i<xs.length;i++) out.push(close(xs[i])/close(xs[i-1])-1);
    return out.slice(-24);
  };
  const pearson=(a,b)=>{
    const n=Math.min(a.length,b.length);if(n<12)return 0;
    a=a.slice(-n);b=b.slice(-n);
    const ma=a.reduce((z,x)=>z+x,0)/n,mb=b.reduce((z,x)=>z+x,0)/n;
    let nume=0,da=0,db=0;
    for(let i=0;i<n;i++){const x=a[i]-ma,y=b[i]-mb;nume+=x*y;da+=x*x;db+=y*y;}
    return da>0&&db>0?nume/Math.sqrt(da*db):0;
  };
  const cr=returns(candidate),vals=heldSymbols.map(s=>({symbol:s,corr:pearson(cr,returns(s))}));
  const maxCorr=vals.length?Math.max(...vals.map(x=>x.corr)):0,threshold=num(env.CRYPTO_CORRELATION_MAX,0.85),correlated=vals.filter(x=>x.corr>threshold);
  return{blocked:correlated.length>=int(env.CRYPTO_MAX_CORRELATED_POSITIONS,2),maxCorrelation:maxCorr,correlatedCount:correlated.length,details:vals};
}

async function buildCandidates(env,now,heldSymbols=[]){
  const allAssets=await assets(env),symbols=allAssets.map(a=>a.symbol);
  if(!symbols.length) return{allAssets,symbols,candidates:[],snapshot:{},localBars:{},deep:[]};
  const [sn,localBars]=await Promise.all([
    snapshots(env,symbols),
    bars(env,symbols,'1Min',Number(now)-75*60000,4000)
  ]);
  const prelim=symbols.map(symbol=>{
    const f=fields(sn[symbol]||{}),l=localResearch(localBars[symbol]||[]);
    const rough=(Math.max(0,l.ret5)*350+Math.max(0,l.ret15)*180+Math.max(0,l.ret60)*80)-f.spread*1200+Math.log10(Math.max(10,f.quoteNotional))*0.2;
    return{symbol,...f,...l,rough};
  }).filter(x=>x.historyOk&&x.bid>0&&x.ask>0&&x.ret5>0&&x.ret15>0&&x.ret60>0)
    .sort((a,b)=>b.rough-a.rough);

  const shortlist=prelim.slice(0,Math.max(1,int(env.CRYPTO_DEEP_RESEARCH_CANDIDATES,3)));
  const cross=await Promise.all(shortlist.map(async c=>({symbol:c.symbol,x:await confirmCoinbaseMomentum(env,c,now)})));
  const crossMap=new Map(cross.map(z=>[z.symbol,z.x]));
  const histBars=shortlist.length?await bars(env,shortlist.map(x=>x.symbol),'5Min',Number(now)-72*3600000,10000):{};
  const deep=shortlist.map(c=>{
    const x=crossMap.get(c.symbol)||{pass:false,reasons:['cross_venue_unavailable']};
    const sp=stopPctFor(env,c,x),h=historicalPerf(histBars[c.symbol]||[],sp,c.atrPct5m||x.atrPct5m||0.01);
    const score=alphaScore(env,c,x,h),reasons=gateReasons(env,c,x,h,score);
    return{...c,crossVenue:x,historical:h,alphaConfidenceScore:score,pass:reasons.length===0,reasons};
  }).sort((a,b)=>b.alphaConfidenceScore-a.alphaConfidenceScore);
  return{allAssets,symbols,candidates:prelim,snapshot:sn,localBars,deep};
}

async function managePositions(env,now,ctx,positions,orders,dd){
  const actions=[],byAsset=new Map(ctx.allAssets.map(a=>[norm(a.symbol),a])),deepMap=new Map(ctx.deep.map(c=>[norm(c.symbol),c]));
  for(const p of positions||[]){
    const asset=byAsset.get(norm(p.symbol));if(!asset)continue;
    const cycle=cycleState(orders,asset.symbol);if(!cycle.open)continue;
    const entry=+p.avg_entry_price||0,qty=Math.abs(+p.qty||0),bid=fields(ctx.snapshot[asset.symbol]||{}).bid||+p.current_price||0;
    if(!(entry>0&&qty>0&&bid>0))continue;
    let c=deepMap.get(norm(asset.symbol));
    if(!c){
      const f={symbol:asset.symbol,...fields(ctx.snapshot[asset.symbol]||{}),...localResearch(ctx.localBars[asset.symbol]||[])};
      let x;try{x=await confirmCoinbaseMomentum(env,f,now);}catch{x={pass:false,atrPct5m:f.atrPct5m||0.01,ema9_5m:f.ema9_5m||0};}
      c={...f,crossVenue:x,alphaConfidenceScore:0};
    }
    const x=c.crossVenue||{},stopPct=stopPctFor(env,c,x),age=cycle.openedAt?Math.max(0,(Number(now)-cycle.openedAt)/60000):999;
    const beBuffer=pct(env.CRYPTO_MAX_ENTRY_SLIPPAGE_PCT,0.001)+pct(env.CRYPTO_MAX_EXIT_SLIPPAGE_PCT,0.001)+0.0005;
    const stopPrice=cycle.tp1Done?entry*(1+beBuffer):entry*(1-stopPct);
    const tp1=entry*(1+num(env.CRYPTO_TP1_R_MULTIPLE,2)*stopPct),emaTrail=Math.max(0,c.ema9_5m||x.ema9_5m||0);
    let reason=null,fraction=1,protectedExit=false;
    if(dd.blocked){reason='drawdownbreaker';}
    else if(bid<=stopPrice){reason=cycle.tp1Done?'breakevenstop':'hardstop';}
    else if(!cycle.tp1Done&&bid>=tp1){reason='tp1';fraction=0.5;protectedExit=true;}
    else if(cycle.tp1Done&&emaTrail>0&&bid<emaTrail){reason='trailing';protectedExit=bid>entry;}
    else if(age>=int(env.CRYPTO_MAX_HOLD_MINUTES,60)){reason='timeexit';protectedExit=bid>entry;}
    if(reason){
      try{
        const o=await sellQty(env,p,asset,qty*fraction,bid,now,reason,protectedExit);
        if(o)actions.push({action:'crypto_sell',symbol:asset.symbol,reason,qty:round(qty*fraction,8),entry:round(entry,8),bid:round(bid,8),stopPrice:round(stopPrice,8),tp1:round(tp1,8),ema9Trail:round(emaTrail,8),ageMinutes:round(age,2),orderType:o.type||null,orderStatus:o.status||null});
      }catch(e){actions.push({action:'crypto_sell_failed',symbol:asset.symbol,reason:e.message});}
    }
  }
  return actions;
}

function recoveryProgress(env,equity){
  const base=num(env.CRYPTO_RECOVERY_BASE_EQUITY_USD,80000),target=num(env.CRYPTO_RECOVERY_TARGET_EQUITY_USD,100000);
  return target>base?clamp((equity-base)/(target-base)*100,0,100):0;
}

function candidateDiagnostic(c,sizingInfo=null,correlation=null,currentValue=0){
  const x=c.crossVenue||{},h=c.historical||{};
  return{
    symbol:c.symbol,
    pass:c.pass,
    alphaConfidenceScore:round(c.alphaConfidenceScore,2),
    reasons:c.reasons||[],
    ret5:round(c.ret5,5),ret15:round(c.ret15,5),ret60:round(c.ret60,5),
    rsi14_5m:round(c.rsi14_5m,2),macdHist5m:round(c.macdHist5m,8),atrPct5m:round(c.atrPct5m,5),
    alpacaSpread:round(c.spread,6),alpacaTopQuoteNotional:round(c.quoteNotional,2),
    coinbase:{
      available:Boolean(x.available),pass:Boolean(x.pass),price:round(x.price,8),bid:round(x.bid,8),ask:round(x.ask,8),dollarVolume24:round(x.dollarVolume24,2),
      spread:round(x.spread,6),depthWithin20bps:round(x.depthWithin20bps,2),
      bidDepthWithin20bps:round(x.bidDepthWithin20bps,2),askDepthWithin20bps:round(x.askDepthWithin20bps,2),
      orderBookImbalance:round(x.orderBookImbalance,4),aggressiveBuySellRatio:round(x.aggressiveBuySellRatio,3),
      cvdUsd:round(x.cvdUsd,2),rvol15:round(x.rvol15,3),rvol60:round(x.rvol60,3),
      atrExpansion:round(x.atrExpansion,3),bbWidthExpansion:round(x.bbWidthExpansion,3),
      vwap24:round(x.vwap24,8),priceDivergence:round(x.priceDivergence,5)
    },
    historical72h:{trades:h.trades||0,winRate:round(h.winRate||0,3),profitFactor:round(h.profitFactor||0,3)},
    currentPositionValue:round(currentValue,2),
    sizing:sizingInfo?{
      winProbability:round(sizingInfo.p,3),quarterKelly:round(sizingInfo.quarterKelly,4),riskPct:round(sizingInfo.riskPct,4),
      riskDollars:round(sizingInfo.riskDollars,2),stopPct:round(sizingInfo.stopPct,5),
      targetNotional:round(sizingInfo.targetNotional,2),twapSliceCap:round(sizingInfo.sliceCap,2),nextSliceNotional:round(sizingInfo.sliceNotional,2)
    }:null,
    correlationGuard:correlation||null
  };
}

export async function cryptoOpportunityDiagnostics(env,now=Date.now()){
  const [positions,account,orders]=await Promise.all([
    alpaca(env,'/v2/positions'),
    alpaca(env,'/v2/account'),
    alpaca(env,'/v2/orders?status=all&limit=500&direction=desc&nested=false')
  ]);
  const held=(positions||[]).filter(p=>String(p.asset_class||'').toLowerCase()==='crypto'||String(p.symbol||'').includes('/')).filter(p=>Math.abs(+p.market_value||0)>1);
  const heldSymbols=held.map(p=>String(p.symbol).includes('/')?p.symbol:`${String(p.symbol).replace(/USD$/,'')}/USD`);
  const ctx=await buildCandidates(env,now,heldSymbols),dd=await portfolioDrawdown(env,account,now);
  const equity=+(account.equity||account.portfolio_value||0),cash=Math.max(0,+(account.non_marginable_buying_power||account.cash||0));
  const maxGross=equity*clamp(num(env.CRYPTO_SPOT_MAX_GROSS_EXPOSURE_PCT,0.90),0.10,1.00),exposure=held.reduce((z,p)=>z+Math.abs(+p.market_value||0),0),available=Math.max(0,maxGross-exposure);
  const openSet=openOrderSymbols(orders),byHeld=new Map(held.map(p=>[norm(p.symbol),p]));
  const out=[];
  for(const c of ctx.deep){
    const p=byHeld.get(norm(c.symbol)),value=Math.abs(+p?.market_value||0),cycle=cycleState(orders,c.symbol),s=sizing(env,equity,cash,available,c,c.crossVenue,c.historical,value);
    const corr=await correlationGuard(env,c.symbol,heldSymbols.filter(x=>norm(x)!==norm(c.symbol)),now);
    const newSlot=!p&&held.length<int(env.CRYPTO_MAX_CONCURRENT_POSITIONS,4),scale=Boolean(p&&cycle.open&&!cycle.tp1Done&&s.sliceNotional>=num(env.CRYPTO_MIN_ORDER_NOTIONAL_USD,25));
    const eligible=c.pass&&!dd.blocked&&!openSet.has(norm(c.symbol))&&!corr.blocked&&s.sliceNotional>=num(env.CRYPTO_MIN_ORDER_NOTIONAL_USD,25)&&(newSlot||scale);
    out.push({...candidateDiagnostic(c,s,corr,value),eligible,scaleIn:scale});
  }
  return{
    strategy:CRYPTO_STRATEGY,readOnly:true,venue:'alpaca_spot',leverageSupported:false,shortsSupported:false,scanCadence:'1_minute_cron',
    scannedUniverseCount:ctx.symbols.length,deepResearchedCount:ctx.deep.length,qualifiedCount:ctx.deep.filter(c=>c.pass).length,
    equity:round(equity,2),cash:round(cash,2),currentExposure:round(exposure,2),maxSpotGrossExposure:round(maxGross,2),availableExposure:round(available,2),
    maxPositions:int(env.CRYPTO_MAX_CONCURRENT_POSITIONS,4),
    drawdown:{rolling24hPct:round(dd.drawdown,5),limitPct:round(dd.max,5),blocked:dd.blocked,breachAt:dd.breachAt,freezeHours:dd.freezeHours,source:dd.source},
    recovery:{baseEquity:num(env.CRYPTO_RECOVERY_BASE_EQUITY_USD,80000),targetEquity:num(env.CRYPTO_RECOVERY_TARGET_EQUITY_USD,100000),progressPct:round(recoveryProgress(env,equity),2)},
    candidates:out
  };
}

export async function cryptoExecutionDirective(env,now=Date.now()){
  const d=await cryptoOpportunityDiagnostics(env,now),c=d.candidates.find(x=>x.eligible)||d.candidates[0]||null;
  const active=Boolean(c?.eligible),stopPct=c?.sizing?.stopPct||0,entryPx=active?(c.coinbase?.ask||0):null;
  return{
    timestamp_utc:new Date(Number(now)).toISOString(),
    scanned_universe_count:d.scannedUniverseCount,
    selected_asset:c?.symbol||null,
    direction:active?'LONG':'NEUTRAL',
    alpha_confidence_score:c?.alphaConfidenceScore||0,
    trade_rationale:{
      volatility_trigger:c?`RVOL15 ${c.coinbase.rvol15} / RVOL60 ${c.coinbase.rvol60}; ATR expansion ${c.coinbase.atrExpansion}; BB expansion ${c.coinbase.bbWidthExpansion}`:'No candidate',
      orderbook_imbalance:c?`Book imbalance ${c.coinbase.orderBookImbalance}; aggressive buy/sell ${c.coinbase.aggressiveBuySellRatio}; CVD USD ${c.coinbase.cvdUsd}`:'No candidate',
      market_structure:c?`5m/15m/60m ROC ${c.ret5}/${c.ret15}/${c.ret60}; RSI5m ${c.rsi14_5m}; MACD hist ${c.macdHist5m}`:'No candidate'
    },
    execution_parameters:{
      allocated_capital_usd:active?c.sizing.nextSliceNotional:0,
      leverage:1,
      entry_price_target:active?entryPx:null,
      stop_loss_price:active&&entryPx?round(entryPx*(1-stopPct),8):null,
      take_profit_1:active&&entryPx?round(entryPx*(1+2*stopPct),8):null,
      take_profit_2:active?'9EMA_5m_trailing_after_TP1':null,
      max_holding_duration_minutes:int(env.CRYPTO_MAX_HOLD_MINUTES,60)
    },
    portfolio_risk_metrics:{
      dollar_amount_at_risk:active?round(c.sizing.nextSliceNotional*stopPct,2):0,
      portfolio_drawdown_risk_pct:active?round((c.sizing.nextSliceNotional*stopPct)/Math.max(1,d.equity),5):0,
      current_recovery_progress_pct:d.recovery.progressPct
    },
    execution_constraints:{
      venue:'alpaca_spot',
      quote_currency:'USD',
      futures_enabled:false,
      shorting_enabled:false,
      leverage_available:false,
      oversized_order_policy:'one depth-capped IOC slice per minute; never exceed 5% of verified ask depth within 20bps',
      daily_drawdown_breaker:d.drawdown
    }
  };
}

export async function runCryptoFreeTier(env,now,{discover=true}={}){
  const [positions,account,orders]=await Promise.all([
    alpaca(env,'/v2/positions'),
    alpaca(env,'/v2/account'),
    alpaca(env,'/v2/orders?status=all&limit=500&direction=desc&nested=false')
  ]);
  const stale=await cancelStaleOrders(env,orders,now);
  const held=(positions||[]).filter(p=>String(p.asset_class||'').toLowerCase()==='crypto'||String(p.symbol||'').includes('/')).filter(p=>Math.abs(+p.market_value||0)>1);
  const heldSymbols=held.map(p=>String(p.symbol).includes('/')?p.symbol:`${String(p.symbol).replace(/USD$/,'')}/USD`);
  const ctx=await buildCandidates(env,now,heldSymbols),dd=await portfolioDrawdown(env,account,now);
  const actions=[...stale,...await managePositions(env,now,ctx,positions,orders,dd)];
  if(!discover||dd.blocked) return{status:actions.length?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:dd.blocked?'drawdown_breaker':'manage_only',drawdown:dd,actions};

  const equity=+(account.equity||account.portfolio_value||0),cash=Math.max(0,+(account.non_marginable_buying_power||account.cash||0));
  const maxGross=equity*clamp(num(env.CRYPTO_SPOT_MAX_GROSS_EXPOSURE_PCT,0.90),0.10,1.00),exposure=held.reduce((z,p)=>z+Math.abs(+p.market_value||0),0),available=Math.max(0,maxGross-exposure);
  const byAsset=new Map(ctx.allAssets.map(a=>[norm(a.symbol),a])),byHeld=new Map(held.map(p=>[norm(p.symbol),p])),openSet=openOrderSymbols(orders);
  let selected=null,selectedSizing=null,selectedCorrelation=null,selectedScale=false;
  for(const c of ctx.deep){
    if(!c.pass||openSet.has(norm(c.symbol)))continue;
    const p=byHeld.get(norm(c.symbol)),value=Math.abs(+p?.market_value||0),cycle=cycleState(orders,c.symbol);
    const s=sizing(env,equity,cash,available,c,c.crossVenue,c.historical,value);
    if(s.sliceNotional<num(env.CRYPTO_MIN_ORDER_NOTIONAL_USD,25))continue;
    const isScale=Boolean(p&&cycle.open&&!cycle.tp1Done);
    if(p&&!isScale)continue;
    if(!p&&held.length>=int(env.CRYPTO_MAX_CONCURRENT_POSITIONS,4))continue;
    const corr=await correlationGuard(env,c.symbol,heldSymbols.filter(x=>norm(x)!==norm(c.symbol)),now);
    if(corr.blocked)continue;
    selected=c;selectedSizing=s;selectedCorrelation=corr;selectedScale=isScale;break;
  }
  if(selected){
    const asset=byAsset.get(norm(selected.symbol));
    try{
      const o=await buySlice(env,selected,asset,selectedSizing.sliceNotional,now,selectedScale?'twapscale':'alpha85');
      if(o)actions.push({
        action:'crypto_buy',symbol:selected.symbol,reason:selectedScale?'v24_depth_capped_twap_scale':'v24_alpha85_entry',
        alphaConfidenceScore:round(selected.alphaConfidenceScore,2),notional:round(selectedSizing.sliceNotional,2),
        targetNotional:round(selectedSizing.targetNotional,2),riskPct:round(selectedSizing.riskPct,4),riskDollars:round(selectedSizing.riskDollars,2),
        stopPct:round(selectedSizing.stopPct,5),quarterKelly:round(selectedSizing.quarterKelly,4),
        correlation:selectedCorrelation,orderType:o.type||null,orderStatus:o.status||null
      });
    }catch(e){actions.push({action:'crypto_buy_failed',symbol:selected.symbol,reason:e.message});}
  }
  return{
    status:actions.some(a=>a.action==='crypto_buy'||a.action==='crypto_sell')?'acted':'hold',
    strategy:CRYPTO_STRATEGY,mode:'alpha85_quant_spot',universeCount:ctx.symbols.length,
    qualified:ctx.deep.filter(c=>c.pass).map(c=>candidateDiagnostic(c)),
    researched:ctx.deep.map(c=>candidateDiagnostic(c)),
    recoveryProgressPct:round(recoveryProgress(env,equity),2),
    drawdown:dd,actions
  };
}

export function cryptoFreeTierStatus(env){
  return{
    strategy:CRYPTO_STRATEGY,endpoint:'paper',market:'24x7_spot',executionVenue:'alpaca',
    scanCadence:'1_minute_cron',streamingTickExecution:false,
    entryOrderType:'protected_limit_ioc_depth_slice',hardStopExitOrderType:'market',profitExitOrderType:'protected_limit_ioc',
    positionPnlSource:'executable_bid_only',crossVenueProvider:'coinbase_exchange',
    crossVenueConfirmationEnabled:String(env.CRYPTO_CROSS_VENUE_CONFIRM_ENABLED??'true')==='true',
    leverage:1,futuresEnabled:false,shortsEnabled:false,
    unsupportedCapabilities:['perpetual_futures_execution','leveraged_crypto_execution','funding_rate','open_interest','millisecond_persistent_stream','spoofing_persistence_detection'],
    alphaMinScore:num(env.CRYPTO_ALPHA_MIN_SCORE,85),
    riskPerTradePct:[pct(env.CRYPTO_RISK_MIN_PCT,0.01),pct(env.CRYPTO_RISK_MAX_PCT,0.015)],
    maxHoldingMinutes:int(env.CRYPTO_MAX_HOLD_MINUTES,60),
    dailyDrawdownLimitPct:pct(env.CRYPTO_MAX_DAILY_DRAWDOWN_PCT,0.03),
    breakerFreezeHours:num(env.CRYPTO_BREAKER_FREEZE_HOURS,4),
    maxPositions:int(env.CRYPTO_MAX_CONCURRENT_POSITIONS,4),
    spotMaxGrossExposurePct:clamp(num(env.CRYPTO_SPOT_MAX_GROSS_EXPOSURE_PCT,0.90),0.10,1.00),
    thresholds:{
      min24hDollarVolume:num(env.CRYPTO_MIN_24H_DOLLAR_VOLUME_USD,10000000),
      minDepthWithin20bps:num(env.CRYPTO_MIN_DEPTH_WITHIN_20BPS_USD,50000),
      maxSpreadPct:pct(env.CRYPTO_MAX_EXECUTION_SPREAD_PCT,0.0005),
      minRvol15:num(env.CRYPTO_MIN_RVOL_15,2.5),minRvol60:num(env.CRYPTO_MIN_RVOL_60,2.5),
      minTakerBuyRatio:num(env.CRYPTO_MIN_TAKER_BUY_RATIO,1.8),
      historicalMinWinRate:num(env.CRYPTO_HISTORICAL_MIN_WIN_RATE,0.60),
      historicalMinProfitFactor:num(env.CRYPTO_HISTORICAL_MIN_PROFIT_FACTOR,2.0)
    },
    research:{
      allActiveTradableSpotUsdPairs:true,multiTimeframeConfirmation:true,timeframes:['1Min','5Min','15Min','60Min','72h-regime-test'],
      rvol:true,atrExpansion:true,bollingerExpansion:true,vwap:true,rsi:true,macd:true,
      coinbaseLevel2Depth:true,aggressiveTradeFlowProxy:true,cvdProxy:true,
      trailing72hWinRateProfitFactor:true,fractionalKellyQuarter:true,correlationGuard24h:true,
      twapLikeDepthCappedSlicing:true,tp1HalfScaleAt2R:true,breakevenAfterTp1:true,ema9TrailingRemainder:true,
      rolling24hDrawdownBreaker:true,recoveryProgressTracking:true,researchBeforeExecution:true,tradeVolumeObjective:false
    }
  };
}

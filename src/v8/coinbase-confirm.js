const COINBASE_API='https://api.exchange.coinbase.com';

const pct=(v,d)=>{const n=Number(v);return Number.isFinite(n)?n:d;};
const num=(v,d)=>{const n=Number(v);return Number.isFinite(n)?n:d;};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const round=(v,d=6)=>{const p=10**d;return Math.round((Number(v)||0)*p)/p;};
const productId=symbol=>`${String(symbol||'').toUpperCase().split('/')[0]}-USD`;

async function getJson(url,timeoutMs){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'cody-alpaca-paper-guard/2.0','Cache-Control':'no-cache'},signal:controller.signal});
    if(!r.ok)throw new Error(`coinbase_${r.status}`);
    return await r.json();
  }finally{clearTimeout(timer);}
}

function candleRows(rows){
  return (Array.isArray(rows)?rows:[])
    .filter(x=>Array.isArray(x)&&x.length>=6&&Number(x[0])>0&&Number(x[4])>0)
    .map(x=>({time:Number(x[0])*1000,low:Number(x[1])||0,high:Number(x[2])||0,open:Number(x[3])||0,close:Number(x[4])||0,volume:Number(x[5])||0}))
    .sort((a,b)=>a.time-b.time);
}

function retAgo(xs,mins){
  if(!xs.length)return 0;
  const latest=xs[xs.length-1],target=latest.time-mins*60000;
  let chosen=xs[0];
  for(const x of xs){if(x.time<=target)chosen=x;else break;}
  return chosen.close>0?latest.close/chosen.close-1:0;
}

function aggregate5(xs){
  const m=new Map();
  for(const x of xs){
    const k=Math.floor(x.time/300000)*300000;
    let b=m.get(k);
    if(!b){b={time:k,open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume};m.set(k,b);}
    else{b.high=Math.max(b.high,x.high);b.low=Math.min(b.low,x.low);b.close=x.close;b.volume+=x.volume;}
  }
  return [...m.values()].sort((a,b)=>a.time-b.time);
}

function atrPct(xs,period=14){
  if(xs.length<period+1)return 0;
  let s=0,n=0;
  for(let i=xs.length-period;i<xs.length;i++){
    const p=xs[i-1].close,h=xs[i].high,l=xs[i].low;
    if(!(p>0&&h>0&&l>0))continue;
    s+=Math.max(h-l,Math.abs(h-p),Math.abs(l-p));n++;
  }
  return n&&xs[xs.length-1].close>0?(s/n)/xs[xs.length-1].close:0;
}

function bbWidth(xs,period=20){
  if(xs.length<period)return 0;
  const v=xs.slice(-period).map(x=>x.close),mean=v.reduce((z,x)=>z+x,0)/v.length;
  const variance=v.reduce((z,x)=>z+(x-mean)**2,0)/v.length,sd=Math.sqrt(variance);
  return mean>0?(4*sd)/mean:0;
}

function candleResearch(rows,now){
  const xs=candleRows(rows);
  if(!xs.length)return{candleCount:0,latestTime:0,latestClose:0,ret5:0,ret15:0,ret60:0,dollarVolume30:0,rvol15:0,rvol60:0,atrPct5m:0,atrExpansion:0,bbWidthExpansion:0};
  const latest=xs[xs.length-1],cut30=Number(now)-30*60000;
  const dollarVolume30=xs.filter(x=>x.time>=cut30).reduce((z,x)=>z+Math.max(0,x.volume*x.close),0);
  const dollarVol=x=>Math.max(0,x.volume*x.close);
  const vols=xs.map(dollarVol),sum=a=>a.reduce((z,x)=>z+x,0);
  const last15=sum(vols.slice(-15)),prev60=vols.slice(-75,-15),base15=prev60.length?sum(prev60)/(prev60.length/15):0;
  const last60=sum(vols.slice(-60)),prev120=vols.slice(-180,-60),base60=prev120.length?sum(prev120)/(prev120.length/60):0;
  const rvol15=base15>0?last15/base15:0,rvol60=base60>0?last60/base60:0;
  const five=aggregate5(xs),currentAtr=atrPct(five,14),priorAtr=five.length>=29?atrPct(five.slice(0,-14),14):0;
  const currentBw=bbWidth(five,20),priorBw=five.length>=40?bbWidth(five.slice(0,-20),20):0;
  return{
    candleCount:xs.length,latestTime:latest.time,latestClose:latest.close,
    ret5:retAgo(xs,5),ret15:retAgo(xs,15),ret60:retAgo(xs,60),
    dollarVolume30,rvol15,rvol60,atrPct5m:currentAtr,
    atrExpansion:priorAtr>0?currentAtr/priorAtr:0,
    bbWidthExpansion:priorBw>0?currentBw/priorBw:0
  };
}

function bookResearch(book,mid,depthBand=0.002){
  let bidDepth=0,askDepth=0;
  const lo=mid*(1-depthBand),hi=mid*(1+depthBand);
  for(const r of book?.bids||[]){
    const p=Number(r?.[0])||0,s=Number(r?.[1])||0;
    if(p>=lo&&p<=mid)bidDepth+=p*s;
  }
  for(const r of book?.asks||[]){
    const p=Number(r?.[0])||0,s=Number(r?.[1])||0;
    if(p<=hi&&p>=mid)askDepth+=p*s;
  }
  const total=bidDepth+askDepth,imbalance=total>0?bidDepth/total:0.5;
  return{bidDepthWithin20bps:bidDepth,askDepthWithin20bps:askDepth,depthWithin20bps:total,orderBookImbalance:imbalance};
}

function tradeResearch(trades){
  let buyUsd=0,sellUsd=0,count=0;
  for(const t of Array.isArray(trades)?trades:[]){
    const p=Number(t?.price)||0,s=Number(t?.size)||0;
    if(!(p>0&&s>0))continue;
    const usd=p*s;count++;
    if(String(t?.side).toLowerCase()==='sell')buyUsd+=usd;
    else if(String(t?.side).toLowerCase()==='buy')sellUsd+=usd;
  }
  return{
    tradeCount:count,aggressiveBuyUsd:buyUsd,aggressiveSellUsd:sellUsd,
    aggressiveBuySellRatio:sellUsd>0?buyUsd/sellUsd:(buyUsd>0?99:0),
    cvdUsd:buyUsd-sellUsd
  };
}

export async function confirmCoinbaseMomentum(env,candidate,now=Date.now()){
  const enabled=String(env.CRYPTO_CROSS_VENUE_CONFIRM_ENABLED??'true')==='true';
  if(!enabled)return{enabled:false,available:false,pass:true,reason:'disabled'};
  const product=productId(candidate?.symbol),timeoutMs=Math.max(750,Math.min(5000,num(env.CRYPTO_COINBASE_TIMEOUT_MS,2500)));
  const lookback=Math.max(120,Math.min(290,num(env.CRYPTO_COINBASE_LOOKBACK_MINUTES,240)));
  const end=new Date(Number(now)).toISOString(),start=new Date(Number(now)-lookback*60000).toISOString();
  try{
    const [candles,ticker,book,trades]=await Promise.all([
      getJson(`${COINBASE_API}/products/${encodeURIComponent(product)}/candles?granularity=60&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,timeoutMs),
      getJson(`${COINBASE_API}/products/${encodeURIComponent(product)}/ticker`,timeoutMs),
      getJson(`${COINBASE_API}/products/${encodeURIComponent(product)}/book?level=2`,timeoutMs),
      getJson(`${COINBASE_API}/products/${encodeURIComponent(product)}/trades?limit=1000`,timeoutMs)
    ]);
    const r=candleResearch(candles,now),price=Number(ticker?.price)||r.latestClose,bid=Number(ticker?.bid)||0,ask=Number(ticker?.ask)||0,mid=bid>0&&ask>0?(bid+ask)/2:price;
    const spread=mid>0&&ask>=bid?(ask-bid)/mid:1,alpacaMid=Number(candidate?.mid)||((Number(candidate?.bid)||0)+(Number(candidate?.ask)||0))/2,divergence=alpacaMid>0&&mid>0?Math.abs(mid/alpacaMid-1):1;
    const tradeTime=Date.parse(ticker?.time||''),latestObserved=Math.max(r.latestTime,Number.isFinite(tradeTime)?tradeTime:0),staleSeconds=latestObserved>0?Math.max(0,(Number(now)-latestObserved)/1000):999999;
    const volume24=Number(ticker?.volume)||0,dollarVolume24=Math.max(0,volume24*price);
    const b=bookResearch(book,mid,pct(env.CRYPTO_DEPTH_BPS,0.002)),t=tradeResearch(trades);

    const minCandles=Math.max(60,Math.floor(num(env.CRYPTO_COINBASE_MIN_CANDLES,120)));
    const minVol=Math.max(0,num(env.CRYPTO_MIN_24H_DOLLAR_VOLUME_USD,10000000));
    const minDepth=Math.max(0,num(env.CRYPTO_MIN_DEPTH_WITHIN_20BPS_USD,50000));
    const maxSpread=pct(env.CRYPTO_MAX_EXECUTION_SPREAD_PCT,0.0005),maxDiv=pct(env.CRYPTO_MAX_CROSS_VENUE_PRICE_DIVERGENCE_PCT,0.005),maxStale=Math.max(30,num(env.CRYPTO_COINBASE_MAX_STALENESS_SECONDS,120));
    const minR15=num(env.CRYPTO_MIN_RVOL_15,2.5),minR60=num(env.CRYPTO_MIN_RVOL_60,2.5),minAtr=num(env.CRYPTO_MIN_ATR_EXPANSION,1.05),minBb=num(env.CRYPTO_MIN_BB_EXPANSION,1.05);
    const minTaker=num(env.CRYPTO_MIN_TAKER_BUY_RATIO,1.8),minImb=num(env.CRYPTO_MIN_ORDERBOOK_IMBALANCE,0.55);
    const reasons=[];
    if(r.candleCount<minCandles)reasons.push('coinbase_candle_count');
    if(staleSeconds>maxStale)reasons.push('coinbase_stale');
    if(!(r.ret5>0&&r.ret15>0&&r.ret60>0))reasons.push('coinbase_positive_velocity');
    if(r.rvol15<minR15)reasons.push('coinbase_rvol15');
    if(r.rvol60<minR60)reasons.push('coinbase_rvol60');
    if(r.atrExpansion<minAtr)reasons.push('coinbase_atr_expansion');
    if(r.bbWidthExpansion<minBb)reasons.push('coinbase_bb_expansion');
    if(dollarVolume24<minVol)reasons.push('coinbase_24h_liquidity');
    if(b.depthWithin20bps<minDepth||b.bidDepthWithin20bps<minDepth*0.25||b.askDepthWithin20bps<minDepth*0.25)reasons.push('coinbase_book_depth_20bps');
    if(spread>maxSpread)reasons.push('coinbase_spread');
    if(t.aggressiveBuySellRatio<minTaker)reasons.push('coinbase_aggressive_buy_ratio');
    if(b.orderBookImbalance<minImb)reasons.push('coinbase_orderbook_imbalance');
    if(t.cvdUsd<=0)reasons.push('coinbase_cvd');
    if(divergence>maxDiv)reasons.push('cross_venue_price_divergence');
    const pass=reasons.length===0;

    const vwap24Rows=candleRows(candles);
    const pv=vwap24Rows.reduce((z,x)=>z+x.close*x.volume,0),vv=vwap24Rows.reduce((z,x)=>z+x.volume,0),vwap24=vv>0?pv/vv:price;
    return{
      enabled:true,provider:'coinbase_exchange',product,available:true,pass,reasons,
      candleCount:r.candleCount,ret5:round(r.ret5),ret15:round(r.ret15),ret60:round(r.ret60),
      dollarVolume30:round(r.dollarVolume30,2),dollarVolume24:round(dollarVolume24,2),
      rvol15:round(r.rvol15,3),rvol60:round(r.rvol60,3),atrPct5m:round(r.atrPct5m,6),
      atrExpansion:round(r.atrExpansion,3),bbWidthExpansion:round(r.bbWidthExpansion,3),
      price:round(price,8),bid:round(bid,8),ask:round(ask,8),spread:round(spread,6),
      vwap24:round(vwap24,8),alpacaMid:round(alpacaMid,8),priceDivergence:round(divergence,6),staleSeconds:round(staleSeconds,1),
      bidDepthWithin20bps:round(b.bidDepthWithin20bps,2),askDepthWithin20bps:round(b.askDepthWithin20bps,2),depthWithin20bps:round(b.depthWithin20bps,2),orderBookImbalance:round(b.orderBookImbalance,4),
      tradeCount:t.tradeCount,aggressiveBuyUsd:round(t.aggressiveBuyUsd,2),aggressiveSellUsd:round(t.aggressiveSellUsd,2),aggressiveBuySellRatio:round(t.aggressiveBuySellRatio,3),cvdUsd:round(t.cvdUsd,2),
      spoofingPersistenceDetectionAvailable:false,openInterestAvailable:false,fundingRateAvailable:false
    };
  }catch(e){
    return{enabled:true,provider:'coinbase_exchange',product,available:false,pass:false,reasons:['coinbase_unavailable'],error:String(e?.message||e)};
  }
}

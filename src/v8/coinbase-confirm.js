const COINBASE_API='https://api.exchange.coinbase.com';

const pct=(v,d)=>{const n=Number(v);return Number.isFinite(n)?n:d;};
const num=(v,d)=>{const n=Number(v);return Number.isFinite(n)?n:d;};
const round=(v,d=6)=>{const p=10**d;return Math.round((Number(v)||0)*p)/p;};
const productId=symbol=>`${String(symbol||'').toUpperCase().split('/')[0]}-USD`;

async function getJson(url,timeoutMs){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'cody-alpaca-paper-guard/1.0'},signal:controller.signal});
    if(!r.ok)throw new Error(`coinbase_${r.status}`);
    return await r.json();
  }finally{clearTimeout(timer);}
}

function candleResearch(rows,now){
  const xs=(Array.isArray(rows)?rows:[]).filter(x=>Array.isArray(x)&&x.length>=5&&Number(x[0])>0&&Number(x[4])>0).map(x=>({time:Number(x[0])*1000,low:Number(x[1])||0,high:Number(x[2])||0,open:Number(x[3])||0,close:Number(x[4])||0,volume:Number(x[5])||0})).sort((a,b)=>a.time-b.time);
  if(!xs.length)return{candleCount:0,latestTime:0,latestClose:0,ret5:0,ret15:0,ret30:0,dollarVolume30:0};
  const latest=xs[xs.length-1];
  const priceAgo=mins=>{
    const target=latest.time-mins*60000;
    let chosen=xs[0];
    for(const x of xs){if(x.time<=target)chosen=x;else break;}
    return chosen.close||0;
  };
  const ret=mins=>{const p=priceAgo(mins);return p>0?latest.close/p-1:0;};
  const cutoff=Number(now)-30*60000;
  const dollarVolume30=xs.filter(x=>x.time>=cutoff).reduce((z,x)=>z+Math.max(0,x.volume*x.close),0);
  return{candleCount:xs.length,latestTime:latest.time,latestClose:latest.close,ret5:ret(5),ret15:ret(15),ret30:ret(30),dollarVolume30};
}

export async function confirmCoinbaseMomentum(env,candidate,now=Date.now()){
  const enabled=String(env.CRYPTO_CROSS_VENUE_CONFIRM_ENABLED??'true')==='true';
  if(!enabled)return{enabled:false,available:false,pass:true,reason:'disabled'};
  const product=productId(candidate?.symbol),timeoutMs=Math.max(750,Math.min(5000,num(env.CRYPTO_COINBASE_TIMEOUT_MS,2500)));
  const end=new Date(Number(now)).toISOString(),start=new Date(Number(now)-42*60000).toISOString();
  try{
    const [candles,ticker]=await Promise.all([
      getJson(`${COINBASE_API}/products/${encodeURIComponent(product)}/candles?granularity=60&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,timeoutMs),
      getJson(`${COINBASE_API}/products/${encodeURIComponent(product)}/ticker`,timeoutMs)
    ]);
    const r=candleResearch(candles,now),price=Number(ticker?.price)||r.latestClose,bid=Number(ticker?.bid)||0,ask=Number(ticker?.ask)||0,mid=bid>0&&ask>0?(bid+ask)/2:price;
    const spread=mid>0&&ask>=bid?(ask-bid)/mid:1,alpacaMid=Number(candidate?.mid)||((Number(candidate?.bid)||0)+(Number(candidate?.ask)||0))/2,divergence=alpacaMid>0&&mid>0?Math.abs(mid/alpacaMid-1):1;
    const tradeTime=Date.parse(ticker?.time||''),latestObserved=Math.max(r.latestTime,Number.isFinite(tradeTime)?tradeTime:0),staleSeconds=latestObserved>0?Math.max(0,(Number(now)-latestObserved)/1000):999999;
    const volume24=Number(ticker?.volume)||0,dollarVolume24=Math.max(0,volume24*price);
    const min5=pct(env.CRYPTO_COINBASE_MIN_5M_MOMENTUM_PCT,0.003),min15=pct(env.CRYPTO_COINBASE_MIN_15M_MOMENTUM_PCT,0.005),min30=pct(env.CRYPTO_COINBASE_MIN_30M_MOMENTUM_PCT,-0.002),minCandles=Math.max(5,Math.floor(num(env.CRYPTO_COINBASE_MIN_CANDLES,12))),minVol=Math.max(0,num(env.CRYPTO_COINBASE_MIN_30M_DOLLAR_VOLUME_USD,100000)),maxSpread=pct(env.CRYPTO_COINBASE_MAX_SPREAD_PCT,0.004),maxDiv=pct(env.CRYPTO_MAX_CROSS_VENUE_PRICE_DIVERGENCE_PCT,0.012),maxStale=Math.max(60,num(env.CRYPTO_COINBASE_MAX_STALENESS_SECONDS,180));
    const reasons=[];
    if(r.candleCount<minCandles)reasons.push('coinbase_candle_count');
    if(staleSeconds>maxStale)reasons.push('coinbase_stale');
    if(r.ret5<min5)reasons.push('coinbase_5m');
    if(r.ret15<min15)reasons.push('coinbase_15m');
    if(r.ret30<min30)reasons.push('coinbase_30m');
    if(r.dollarVolume30<minVol)reasons.push('coinbase_30m_liquidity');
    if(spread>maxSpread)reasons.push('coinbase_spread');
    if(divergence>maxDiv)reasons.push('cross_venue_price_divergence');
    const pass=reasons.length===0;
    return{enabled:true,provider:'coinbase_exchange',product,available:true,pass,reasons,candleCount:r.candleCount,ret5:round(r.ret5),ret15:round(r.ret15),ret30:round(r.ret30),dollarVolume30:round(r.dollarVolume30,2),dollarVolume24:round(dollarVolume24,2),price:round(price,8),bid:round(bid,8),ask:round(ask,8),spread:round(spread),alpacaMid:round(alpacaMid,8),priceDivergence:round(divergence),staleSeconds:round(staleSeconds,1)};
  }catch(e){
    return{enabled:true,provider:'coinbase_exchange',product,available:false,pass:false,reasons:['coinbase_unavailable'],error:String(e?.message||e)};
  }
}

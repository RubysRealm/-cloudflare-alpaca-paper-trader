import { alpaca, marketDataRaw } from './api.js';
import { pct, int, clamp } from './config.js';

let cryptoCache={at:0,symbols:[]};

async function cryptoSymbols(env){
  if(cryptoCache.symbols.length&&Date.now()-cryptoCache.at<60000)return cryptoCache.symbols;
  try{
    const a=await alpaca(env,'/v2/assets?status=active&asset_class=crypto');
    const symbols=(Array.isArray(a)?a:[]).filter(x=>x?.symbol&&x.tradable!==false&&x.status!=='inactive'&&String(x.symbol).endsWith('/USD')).map(x=>x.symbol);
    if(symbols.length)cryptoCache={at:Date.now(),symbols};
  }catch{}
  return cryptoCache.symbols;
}

function cryptoSnapshotFields(s={}){
  const q=s.latestQuote||s.latest_quote||{},m=s.minuteBar||s.minute_bar||{},d=s.dailyBar||s.daily_bar||{},p=s.prevDailyBar||s.prev_daily_bar||{};
  const bid=+(q.bp??q.bid_price??0),ask=+(q.ap??q.ask_price??0),mid=bid>0&&ask>0?(bid+ask)/2:+(m.c??m.close??d.c??d.close??0),spread=mid>0&&ask>=bid?(ask-bid)/mid:1;
  const mo=+(m.o??m.open??0),mc=+(m.c??m.close??mid),dc=+(d.c??d.close??mid),pc=+(p.c??p.close??0);
  return{mid,spread,minRet:mo>0?mc/mo-1:0,dayRet:pc>0?dc/pc-1:0};
}

export async function routeResearchMarket(env,now){
  let stockBest={symbol:null,score:0,move:0},cryptoBest={symbol:null,score:0,move:0};
  try{
    const d=await marketDataRaw(env,`/v1beta1/screener/stocks/movers?top=${int(env.FREE_TIER_ROUTER_STOCK_TOP,20)}`);
    for(const z of d?.gainers||[]){
      const symbol=String(z?.symbol||'').toUpperCase();
      const move=Math.max(0,(+(z?.percent_change??z?.percentChange??0))/100);
      if(!symbol||!(move>0))continue;
      const score=move-pct(env.MAX_ENTRY_SLIPPAGE_PCT,0.001)-pct(env.MAX_EXIT_SLIPPAGE_PCT,0.0012);
      if(score>stockBest.score)stockBest={symbol,score,move};
    }
  }catch{}

  try{
    const symbols=await cryptoSymbols(env);
    if(symbols.length){
      const d=await marketDataRaw(env,`/v1beta3/crypto/us/snapshots?symbols=${symbols.map(encodeURIComponent).join(',')}`),sn=d?.snapshots||d||{};
      const fee=pct(env.CRYPTO_TAKER_FEE_PCT,0.0025)*2,slip=pct(env.CRYPTO_MAX_ENTRY_SLIPPAGE_PCT,0.0015)+pct(env.CRYPTO_MAX_EXIT_SLIPPAGE_PCT,0.0015);
      for(const symbol of symbols){
        const x=cryptoSnapshotFields(sn[symbol]||{});if(!(x.mid>0)||x.spread>pct(env.CRYPTO_MAX_SPREAD_PCT,0.004))continue;
        const movement=Math.max(0,x.minRet*2,Math.max(0,x.dayRet)*0.25);
        const score=movement-fee-slip-x.spread;
        if(score>cryptoBest.score)cryptoBest={symbol,score,move:movement};
      }
    }
  }catch{}

  const stockOpen=await alpaca(env,'/v2/clock').then(x=>Boolean(x?.is_open)).catch(()=>false);
  let market='crypto',reason='crypto_only_available';
  if(stockOpen){
    const stockAdjusted=Math.max(0,stockBest.score);
    const cryptoAdjusted=Math.max(0,cryptoBest.score);
    if(stockAdjusted>cryptoAdjusted*1.05){market='stock';reason='stock_best_net_opportunity';}
    else if(cryptoAdjusted>stockAdjusted*1.05){market='crypto';reason='crypto_best_net_opportunity';}
    else {
      const minute=new Date(now).getUTCMinutes();market=minute%2===0?'stock':'crypto';reason='opportunity_tie_rotate';
    }
  }
  return{market,reason,stockOpen,stockBest:{...stockBest,score:clamp(stockBest.score,-1,1)},cryptoBest:{...cryptoBest,score:clamp(cryptoBest.score,-1,1)}};
}

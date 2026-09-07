import { alpaca, marketDataRaw } from './api.js';
import { num, pct, int, clamp, round } from './config.js';

export const CRYPTO_STRATEGY='free-tier-crypto-v13';
export const CRYPTO_PREFIX='papercrypto-v13-';

const MEGA_CAPS=new Set(['BTC/USD','ETH/USD','SOL/USD']);
const norm=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const cid=(side,symbol,now,tag)=>`${CRYPTO_PREFIX}${side}-${tag}-${norm(symbol)}-${Number(now).toString(36)}`.slice(0,48);
let assetCache={at:0,assets:[]};

async function assets(env){
  if(assetCache.assets.length&&Date.now()-assetCache.at<300000)return assetCache.assets;
  const a=await alpaca(env,'/v2/assets?status=active&asset_class=crypto');
  const assets=(Array.isArray(a)?a:[]).filter(x=>x?.symbol&&x.tradable!==false&&x.status!=='inactive'&&String(x.symbol).endsWith('/USD'));
  if(assets.length)assetCache={at:Date.now(),assets};
  return assetCache.assets;
}

async function snapshots(env,symbols){
  const d=await marketDataRaw(env,`/v1beta3/crypto/us/snapshots?symbols=${symbols.map(encodeURIComponent).join(',')}`);
  return d?.snapshots||d||{};
}

function fields(s={}){
  const q=s.latestQuote||s.latest_quote||{},m=s.minuteBar||s.minute_bar||{},d=s.dailyBar||s.daily_bar||{},p=s.prevDailyBar||s.prev_daily_bar||{};
  const bid=+(q.bp??q.bid_price??0),ask=+(q.ap??q.ask_price??0),mid=bid>0&&ask>0?(bid+ask)/2:+(m.c??m.close??d.c??d.close??0);
  const spread=mid>0&&ask>=bid?(ask-bid)/mid:1;
  const mo=+(m.o??m.open??0),mc=+(m.c??m.close??mid),dc=+(d.c??d.close??mid),pc=+(p.c??p.close??0),vol=+(d.v??d.volume??0);
  return{bid,ask,mid,spread,minRet:mo>0?mc/mo-1:0,dayRet:pc>0?dc/pc-1:0,dollarVolume:Math.max(0,dc*vol)};
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

async function buy(env,c,asset,notional,now){
  const lim=fmtPrice(c.ask*(1+pct(env.CRYPTO_MAX_ENTRY_SLIPPAGE_PCT,0.0015)),asset,true);
  return alpaca(env,'/v2/orders',{method:'POST',body:JSON.stringify({symbol:c.symbol,notional:round(notional,2).toFixed(2),side:'buy',type:'limit',limit_price:lim,time_in_force:'ioc',client_order_id:cid('buy',c.symbol,now,'velocity')})});
}

async function sell(env,p,asset,bid,now,reason){
  if(!(bid>0))return null;
  const qty=fmtQty(Math.abs(+p.qty||0),asset);
  if(!(Number(qty)>0))return null;
  const lim=fmtPrice(bid*(1-pct(env.CRYPTO_MAX_EXIT_SLIPPAGE_PCT,0.0015)),asset,false);
  return alpaca(env,'/v2/orders',{method:'POST',body:JSON.stringify({symbol:asset.symbol,qty,side:'sell',type:'limit',limit_price:lim,time_in_force:'ioc',client_order_id:cid('sell',asset.symbol,now,reason)})});
}

function rankCandidates(env,all){
  const fee=pct(env.CRYPTO_TAKER_FEE_PCT,0.0025)*2;
  const expectedSlip=(pct(env.CRYPTO_MAX_ENTRY_SLIPPAGE_PCT,0.0015)+pct(env.CRYPTO_MAX_EXIT_SLIPPAGE_PCT,0.0015))*0.25;
  const maxSpread=pct(env.CRYPTO_MAX_SPREAD_PCT,0.004);
  const ranked=all.map(x=>{
    const shortMove=Math.max(0,x.minRet),dayMove=Math.max(0,x.dayRet);
    const projectedMove=Math.max(shortMove*3.5,dayMove*0.30);
    const cost=fee+expectedSlip+x.spread,net=projectedMove-cost;
    const highVelocity=shortMove>=0.0015||dayMove>=0.02;
    const antiChase=x.minRet<0.035&&x.dayRet<0.30;
    const liquid=x.bid>0&&x.ask>0&&x.spread<=maxSpread&&x.dollarVolume>=50000;
    const mega=MEGA_CAPS.has(x.symbol),megaExceptional=shortMove>=0.008||dayMove>=0.08;
    const velocity=shortMove*340+dayMove*18;
    const discoveryBonus=mega?0:Math.min(1.6,shortMove*150+dayMove*4.5);
    const megaPenalty=mega&&!megaExceptional?5:0;
    const grossRevenuePotential=projectedMove*Math.log10(Math.max(10,x.dollarVolume));
    const score=grossRevenuePotential*40+net*220+velocity+discoveryBonus-megaPenalty;
    const pass=liquid&&highVelocity&&antiChase&&x.minRet>-0.004&&x.dayRet>-0.08&&net>0&&(!mega||megaExceptional);
    return{...x,projectedMove,cost,net,grossRevenuePotential,score,pass,mega,megaExceptional};
  }).filter(x=>x.pass).sort((a,b)=>b.score-a.score);
  return ranked;
}

async function manage(env,now,allAssets,positions,snap,ranked){
  const actions=[],byNorm=new Map(allAssets.map(a=>[norm(a.symbol),a])),byRank=new Map(ranked.map(x=>[norm(x.symbol),x])),best=ranked[0]||null;
  const held=(positions||[]).filter(p=>byNorm.has(norm(p.symbol))&&Math.abs(+p.market_value||(+p.qty||0)*(+p.current_price||0))>1);
  const takeProfitPct=pct(env.CRYPTO_TAKE_PROFIT_PCT,0.0125),hardStopPct=pct(env.CRYPTO_HARD_STOP_PCT,0.012);
  for(const p of held){
    const asset=byNorm.get(norm(p.symbol)),s=asset.symbol,f=fields(snap[s]||{}),entry=+p.avg_entry_price||0,bid=f.bid>0?f.bid:+p.current_price||0,pnl=entry>0&&bid>0?bid/entry-1:0;
    const current=byRank.get(norm(s)),currentScore=current?.score??-99;
    const reversal=f.minRet<-0.0015,hardStop=pnl<=-hardStopPct,takeProfit=pnl>=takeProfitPct,profitFade=pnl>=0.006&&reversal;
    const stagnant=Math.abs(f.minRet)<0.0005&&f.dayRet<0.015;
    const megaSlow=MEGA_CAPS.has(s)&&!(f.minRet>=0.008||f.dayRet>=0.08);
    const stronger=best&&norm(best.symbol)!==norm(s)&&best.score>currentScore+0.45;
    const rotate=Boolean(stronger&&(stagnant||megaSlow||!current)&&pnl>-0.006);
    if(hardStop||takeProfit||profitFade||rotate||reversal){
      const reason=hardStop?'hardstop':takeProfit?'takeprofit':profitFade?'profitfade':rotate?'rotate':'reversal';
      try{const o=await sell(env,p,asset,bid,now,reason);if(o)actions.push({action:'crypto_sell',symbol:s,reason:hardStop?'hard_stop':takeProfit?'take_profit':profitFade?'profit_momentum_fading':rotate?'rotate_to_faster_mover':'momentum_reversal',pnlPct:round(pnl,5),replacement:rotate?best?.symbol:null,orderStatus:o?.status||null});}
      catch(e){actions.push({action:'crypto_sell_failed',symbol:s,reason:e.message});}
    }
  }
  return actions;
}

export async function runCryptoFreeTier(env,now,{discover=true}={}){
  const allAssets=await assets(env),symbols=allAssets.map(a=>a.symbol);
  const [positions,account]=await Promise.all([alpaca(env,'/v2/positions'),alpaca(env,'/v2/account')]);
  if(!symbols.length)return{status:'hold',strategy:CRYPTO_STRATEGY,mode:'velocity_rank',reason:'no_tradable_usd_crypto'};

  const sn=await snapshots(env,symbols),light=symbols.map(symbol=>({symbol,...fields(sn[symbol]||{})}));
  const ranked=rankCandidates(env,light),finalists=ranked.slice(0,int(env.FREE_TIER_CRYPTO_FINALISTS,6));
  const actions=await manage(env,now,allAssets,positions,sn,ranked);
  if(!discover)return{status:actions.length?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'manage_only',actions};

  const byNorm=new Map(allAssets.map(a=>[norm(a.symbol),a]));
  const held=(positions||[]).filter(p=>byNorm.has(norm(p.symbol))&&Math.abs(+p.market_value||(+p.qty||0)*(+p.current_price||0))>1);
  const maxPos=int(env.CRYPTO_MAX_CONCURRENT_POSITIONS,2);
  if(held.length>=maxPos||!finalists.length)return{status:actions.length?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'velocity_rank',universeCount:symbols.length,qualified:finalists.map(x=>({symbol:x.symbol,minuteMove:round(x.minRet,5),dayMove:round(x.dayRet,5),grossPotential:round(x.grossRevenuePotential,5),net:round(x.net,5),score:round(x.score,4)})),actions};

  const heldSet=new Set(held.map(p=>norm(p.symbol))),c=finalists.find(x=>!heldSet.has(norm(x.symbol)));
  if(!c)return{status:actions.length?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'velocity_rank',universeCount:symbols.length,qualified:finalists.map(x=>x.symbol),actions};

  const asset=byNorm.get(norm(c.symbol)),cash=Math.max(0,+(account.non_marginable_buying_power||account.cash||account.buying_power||0));
  const configuredCap=Math.min(num(env.CRYPTO_ORDER_NOTIONAL_USD,25000),num(env.CRYPTO_MAX_POSITION_USD,25000));
  const baseCap=Math.min(configuredCap,cash*0.25);
  const confidence=clamp(0.58+c.score*0.035,0.55,1),notional=baseCap*confidence;
  if(notional>=num(env.CRYPTO_MIN_ORDER_NOTIONAL_USD,25)){
    try{const o=await buy(env,c,asset,notional,now);actions.push({action:'crypto_buy',symbol:c.symbol,reason:'v13_highest_gross_velocity_candidate',minuteMove:round(c.minRet,5),dayMove:round(c.dayRet,5),grossPotential:round(c.grossRevenuePotential,5),expectedNetEdge:round(c.net,5),score:round(c.score,4),notional:round(notional,2),orderStatus:o?.status||null});}
    catch(e){actions.push({action:'crypto_buy_failed',symbol:c.symbol,reason:e.message});}
  }
  return{status:actions.length?'acted':'hold',strategy:CRYPTO_STRATEGY,mode:'velocity_rank',universeCount:symbols.length,qualified:finalists.map(x=>({symbol:x.symbol,minuteMove:round(x.minRet,5),dayMove:round(x.dayRet,5),grossPotential:round(x.grossRevenuePotential,5),net:round(x.net,5),score:round(x.score,4)})),actions};
}

export function cryptoFreeTierStatus(env){
  return{strategy:CRYPTO_STRATEGY,endpoint:'paper',market:'24x7',freeTier:{cpuMsPerInvocation:10,requestLimitPerDay:100000,architecture:'all_tradable_usd_crypto_gross_velocity_rank',finalists:int(env.FREE_TIER_CRYPTO_FINALISTS,6),alternatingMarketDiscovery:false},research:{allActiveTradablePairs:true,fullExecutableUsdUniverse:true,percentageVelocityPriority:true,grossRevenuePriority:true,megaCapDeprioritization:true,stagnantPositionRotation:true,profitTargetLiquidation:true,timeframes:['1Min','1Day'],crossSectionRelativeStrength:true,researchBeforeExecution:true,tradeVolumeObjective:true,antiChaseEntryTiming:true},takeProfitPct:pct(env.CRYPTO_TAKE_PROFIT_PCT,0.0125)};
}

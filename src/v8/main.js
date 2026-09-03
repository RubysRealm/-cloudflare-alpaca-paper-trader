import { TradingState } from './state.js';
import { alpaca } from './api.js';
import { runStockFreeTier, stockFreeTierStatus, STOCK_STRATEGY } from './free-tier-stock.js';
import { runCryptoFreeTier, cryptoFreeTierStatus, CRYPTO_STRATEGY, CRYPTO_PREFIX } from './free-tier-crypto.js';
import { routeResearchMarket } from './free-tier-router.js';

export { TradingState };

const BUILD='free-tier-research-v2';

function cryptoPerformance(orders){
  const inv={},closed=[];
  for(const o of [...orders].filter(o=>String(o.client_order_id||'').startsWith(CRYPTO_PREFIX)&&o.status==='filled'&&o.filled_avg_price).sort((a,b)=>String(a.filled_at||'').localeCompare(String(b.filled_at||'')))){
    const k=String(o.symbol||'').replace('/','').toUpperCase(),q=Math.abs(+o.filled_qty||0),p=+o.filled_avg_price||0;if(!(q>0&&p>0))continue;const x=inv[k]||={qty:0,cost:0};if(o.side==='buy'){x.qty+=q;x.cost+=q*p;continue;}if(!(x.qty>0))continue;const sold=Math.min(q,x.qty),avg=x.cost/x.qty;closed.push(sold*(p-avg));x.qty-=sold;x.cost-=sold*avg;if(x.qty<1e-8){x.qty=0;x.cost=0;}
  }
  const wins=closed.filter(x=>x>0),losses=closed.filter(x=>x<0),rp=closed.reduce((a,x)=>a+x,0),gw=wins.reduce((a,x)=>a+x,0),gl=losses.reduce((a,x)=>a+Math.abs(x),0);
  return{closedTrades:closed.length,wins:wins.length,losses:losses.length,winRate:closed.length?wins.length/closed.length:0,realizedPnl:rp,expectancy:closed.length?rp/closed.length:0,profitFactor:gl?gw/gl:gw>0?99:0};
}

async function liveCrypto(env){
  const [positions,orders,account]=await Promise.all([alpaca(env,'/v2/positions'),alpaca(env,'/v2/orders?status=all&limit=500&direction=desc&nested=false'),alpaca(env,'/v2/account')]);
  const all=(orders||[]).filter(o=>String(o.client_order_id||'').startsWith('papercrypto-')),current=all.filter(o=>String(o.client_order_id||'').startsWith(CRYPTO_PREFIX)),legacy=all.filter(o=>!String(o.client_order_id||'').startsWith(CRYPTO_PREFIX));
  const cp=(positions||[]).filter(p=>String(p.asset_class||'').toLowerCase()==='crypto'||String(p.symbol||'').includes('/')).map(p=>({symbol:p.symbol,qty:+p.qty||0,marketValue:+p.market_value||0,avgEntryPrice:+p.avg_entry_price||0,currentPrice:+p.current_price||0,unrealizedPl:+p.unrealized_pl||0,unrealizedPlpc:+p.unrealized_plpc||0}));
  return{endpoint:'paper',strategy:CRYPTO_STRATEGY,cryptoEntryBuild:BUILD,orderPrefix:CRYPTO_PREFIX,exitPolicy:'profit_reversal_protection',legacyExecutionActive:false,cryptoAccountStatus:account?.crypto_status||null,cryptoPositionCount:cp.filter(p=>Math.abs(p.marketValue||p.qty*p.currentPrice)>1).length,rawCryptoPositionCount:cp.length,cryptoPositions:cp.filter(p=>Math.abs(p.marketValue||p.qty*p.currentPrice)>1),dustPositions:cp.filter(p=>Math.abs(p.marketValue||p.qty*p.currentPrice)<=1),currentStrategyOrderCount:current.length,legacyHistoricalOrderCount:legacy.length,lastCurrentStrategyOrderAt:current[0]?.submitted_at||null,performance:cryptoPerformance(current),recentCurrentStrategyOrders:current.slice(0,20).map(o=>({symbol:o.symbol,side:o.side,type:o.type,status:o.status,submittedAt:o.submitted_at,filledAt:o.filled_at||null,filledAvgPrice:+o.filled_avg_price||0,filledQty:+o.filled_qty||0,notional:+o.notional||0,limitPrice:+o.limit_price||0,clientOrderId:o.client_order_id}))};
}

async function accountState(env){
  const [account,positions,orders]=await Promise.all([alpaca(env,'/v2/account'),alpaca(env,'/v2/positions'),alpaca(env,'/v2/orders?status=all&limit=100&direction=desc&nested=false')]);
  return{mode:'direct_alpaca_rest',build:BUILD,equity:+account.equity||0,lastEquity:+account.last_equity||0,buyingPower:+account.buying_power||0,positions:(positions||[]).length,positionSummary:(positions||[]).map(p=>({symbol:p.symbol,marketValue:+p.market_value||0,unrealizedPl:+p.unrealized_pl||0,unrealizedPlpc:+p.unrealized_plpc||0})),recentOrders:(orders||[]).slice(0,20).map(o=>({symbol:o.symbol,side:o.side,status:o.status,submittedAt:o.submitted_at,filledAt:o.filled_at||null,clientOrderId:o.client_order_id}))};
}

const app={
 async fetch(request,env){
  const url=new URL(request.url);
  if(request.method!=='GET')return Response.json({error:'not_found'},{status:404});
  if(url.pathname==='/api/status')return Response.json({...stockFreeTierStatus(env),status:String(env.TRADING_ENABLED)==='true'?'armed':'disabled',build:BUILD,adaptiveMarketRouting:true},{headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/api/crypto/status')return Response.json({...cryptoFreeTierStatus(env),enabled:String(env.CRYPTO_TRADING_ENABLED??'true')==='true',cryptoEntryBuild:BUILD,adaptiveMarketRouting:true},{headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/api/router/opportunity')return Response.json({...await routeResearchMarket(env,Date.now()),build:BUILD},{headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/api/crypto/live')return Response.json(await liveCrypto(env),{headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/api/state')return Response.json(await accountState(env),{headers:{'Cache-Control':'no-store'}});
  if(url.pathname==='/api/portfolio/history'){try{return Response.json(await alpaca(env,'/v2/account/portfolio/history?period=1D&timeframe=1Min&intraday_reporting=continuous&pnl_reset=no_reset'),{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:e.message},{status:502});}}
  return Response.json({service:'alpaca-paper-guard',build:BUILD,stock:STOCK_STRATEGY,crypto:CRYPTO_STRATEGY,endpoint:'paper',adaptiveMarketRouting:true});
 },
 async scheduled(controller,env,ctx){
  const now=controller.scheduledTime;
  ctx.waitUntil((async()=>{
    const route=await routeResearchMarket(env,now);
    const result=route.market==='stock'
      ? await runStockFreeTier(env,now,{discover:true})
      : await runCryptoFreeTier(env,now,{discover:true});
    console.log(JSON.stringify({event:'free_tier_cycle',build:BUILD,route,...result}));
  })().catch(e=>console.error(JSON.stringify({event:'free_tier_cycle_failed',build:BUILD,message:e.message}))));
 }
};
export default app;

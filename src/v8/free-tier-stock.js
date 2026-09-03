import { alpaca, marketDataRaw, fetchBars, fetchSnapshots, fetchLatestQuote, fetchAsset, recentNewsContext } from './api.js';
import { timeframeSignal, combineSignals } from './signals.js';
import { botLotsFromOrders } from './performance.js';
import { placeLimitBuy, placeLimitSell } from './execution.js';
import { num, pct, int, clamp, round, etParts } from './config.js';

export const STOCK_STRATEGY = 'free-tier-deep-stock-v12';
const PREFIXES = ['paper8-','paper-'];
const isBot = o => PREFIXES.some(p => String(o?.client_order_id||'').startsWith(p));
const commonStockLike=s=>/^[A-Z]{1,5}$/.test(s)&&!(s.length===5&&/[WUR]$/.test(s));

function snapFields(s={}) {
  const q=s.latestQuote||s.latest_quote||{}, m=s.minuteBar||s.minute_bar||{}, d=s.dailyBar||s.daily_bar||{}, p=s.prevDailyBar||s.prev_daily_bar||{};
  const bid=+(q.bp??q.bid_price??0), ask=+(q.ap??q.ask_price??0), mid=bid>0&&ask>0?(bid+ask)/2:+(m.c??m.close??d.c??d.close??0);
  const spread=mid>0&&ask>=bid?(ask-bid)/mid:1;
  const mopen=+(m.o??m.open??0), mclose=+(m.c??m.close??mid), dclose=+(d.c??d.close??mid), pclose=+(p.c??p.close??0), vol=+(d.v??d.volume??0);
  return {bid,ask,mid,spread,minRet:mopen>0?mclose/mopen-1:0,dayRet:pclose>0?dclose/pclose-1:0,dollarVolume:Math.max(0,dclose*vol)};
}

async function discoverySymbols(env){
  const out=[];
  try{const x=await marketDataRaw(env,`/v1beta1/screener/stocks/movers?top=${int(env.FREE_TIER_STOCK_MOVER_COUNT,30)}`);for(const z of [...(x?.gainers||[]),...(x?.losers||[])]) if(z?.symbol) out.push(String(z.symbol).toUpperCase());}catch{}
  try{const x=await marketDataRaw(env,`/v1beta1/screener/stocks/most-actives?top=${int(env.FREE_TIER_STOCK_ACTIVE_COUNT,30)}&by=volume`);for(const z of x?.most_actives||x?.mostActives||[]) if(z?.symbol) out.push(String(z.symbol).toUpperCase());}catch{}
  return [...new Set(out)].filter(commonStockLike).slice(0,int(env.FREE_TIER_STOCK_DISCOVERY_MAX,60));
}

async function tradeTape(env,symbol){
  const start=new Date(Date.now()-20*60000).toISOString();
  try{
    const d=await marketDataRaw(env,`/v2/stocks/${encodeURIComponent(symbol)}/trades?start=${encodeURIComponent(start)}&limit=80&feed=iex&sort=desc`);
    const a=d?.trades||[]; if(!a.length) return {ok:false,pressure:0,lastVsVwap:0,count:0};
    let pv=0,v=0; for(const t of a){const p=+(t.p??t.price??0),s=+(t.s??t.size??0);if(p>0&&s>0){pv+=p*s;v+=s;}}
    const last=+(a[0]?.p??a[0]?.price??0), vw=v?pv/v:0; return {ok:v>0,pressure:vw>0?(last/vw-1):0,lastVsVwap:vw>0?(last/vw-1):0,count:a.length};
  }catch{return {ok:false,pressure:0,lastVsVwap:0,count:0};}
}

async function deepCandidate(env,symbol,snapshot,news){
  const [m1,m5,m15,h1,d1,tape]=await Promise.all([
    fetchBars(env,symbol,'1Min',35),fetchBars(env,symbol,'5Min',40),fetchBars(env,symbol,'15Min',30),fetchBars(env,symbol,'1Hour',24),fetchBars(env,symbol,'1Day',20),tradeTape(env,symbol)
  ]);
  const base=combineSignals(symbol,timeframeSignal(symbol,m1.bars),timeframeSignal(symbol,m5.bars),timeframeSignal(symbol,m15.bars),snapshot||{});
  if(!base?.valid) return null;
  const hs=timeframeSignal(symbol,h1.bars), ds=timeframeSignal(symbol,d1.bars), sf=snapFields(snapshot);
  const catalyst=news||{score:0,positive:0,negative:0,severe:false,headlines:[]};
  const flow=(base.s1?.ret1>0&&base.s5?.ret1>=0)||(base.s5?.ret3>0&&base.s15?.ret1>=0);
  const dailySupport=Boolean(ds?.trend||ds?.trendSlope||(!ds?.downTrend&&ds?.ret1>=0));
  const higherSupport=Boolean(hs?.trend||hs?.trendSlope||(!hs?.downTrend&&hs?.ret1>=0));
  const movement=Math.max(base.atrPct||0,Math.max(0,base.s1?.ret3||0)*1.5,Math.max(0,base.s5?.ret3||0)*1.25,Math.max(0,hs?.ret1||0)*0.6);
  const cost=sf.spread+pct(env.MAX_ENTRY_SLIPPAGE_PCT,0.001)+pct(env.MAX_EXIT_SLIPPAGE_PCT,0.0012);
  const gross=Math.max(movement,(base.atrPct||0)*1.6,0.0005), net=gross-cost;
  let probability=0.42+(base.trendVotes||0)*0.035+(higherSupport?0.08:-0.07)+(dailySupport?0.07:-0.08)+(flow?0.06:-0.04)+clamp(tape.pressure*14,-0.08,0.08)+clamp((catalyst.score||0)/100,-0.16,0.12);
  probability=clamp(probability,0.08,0.94);
  const score=Math.max(0,net)*probability*(1+clamp(movement*55,0,3));
  const pass=!catalyst.severe&&flow&&higherSupport&&dailySupport&&tape.ok&&tape.lastVsVwap>-0.0015&&sf.spread<=pct(env.MAX_SPREAD_PCT,0.003)&&net>0;
  return {...base,symbol,probability,opportunityScore:score,movementOpportunity:movement,expectedNetEdge:net,expectedGrossMove:gross,catalyst,tape,dailySupport,higherSupport,deepPass:pass};
}

async function managePositions(env,now,positions,orders,snapshots){
  const actions=[],lots=botLotsFromOrders(orders),open=new Set((orders||[]).filter(o=>isBot(o)&&['new','accepted','partially_filled','pending_new'].includes(o.status)).map(o=>o.symbol));
  for(const p of positions||[]){
    const lot=lots[p.symbol]; if(!lot||!(lot.qty>1e-8)||open.has(p.symbol)) continue;
    const qty=Math.min(Math.abs(+p.qty||0),lot.qty); if(!(qty>1e-8)) continue;
    const sf=snapFields(snapshots?.[p.symbol]||{}),entry=+(lot.avgEntry||p.avg_entry_price||0),price=sf.bid>0?sf.bid:+p.current_price||0,pnl=entry>0&&price>0?price/entry-1:0;
    const {hour,minute}=etParts(now);
    if(hour>15||(hour===15&&minute>=50)){
      try{await placeLimitSell(env,{...p,qty:String(qty),avg_entry_price:String(entry)},{price,bid:price},now,'end_of_day_flatten');actions.push({action:'sell',symbol:p.symbol,reason:'end_of_day_flatten',pnlPct:round(pnl,5)});}catch{}
      continue;
    }
    if(pnl>0){
      try{
        const [a,b]=await Promise.all([fetchBars(env,p.symbol,'1Min',12),fetchBars(env,p.symbol,'5Min',10)]),s1=timeframeSignal(p.symbol,a.bars),s5=timeframeSignal(p.symbol,b.bars);
        const rollover=(s1?.ret1<0&&s1?.ret3<0)||(s1?.ret1<0&&s5?.ret1<=0);
        if(rollover){await placeLimitSell(env,{...p,qty:String(qty),avg_entry_price:String(entry)},{price,bid:price,s1,s5},now,'profit_edge_fading');actions.push({action:'sell',symbol:p.symbol,reason:'profit_edge_fading',pnlPct:round(pnl,5)});}
      }catch{}
    }
  }
  return actions;
}

export async function runStockFreeTier(env,now,{discover=true}={}){
  const clock=await alpaca(env,'/v2/clock');
  const [positions,orders,account]=await Promise.all([alpaca(env,'/v2/positions'),alpaca(env,'/v2/orders?status=all&limit=300&direction=desc&nested=false'),alpaca(env,'/v2/account')]);
  const held=(positions||[]).filter(p=>String(p.asset_class||'').toLowerCase()!=='crypto'&&!String(p.symbol||'').includes('/')).map(p=>p.symbol);
  let heldSnaps={}; if(held.length&&clock.is_open){try{heldSnaps=(await fetchSnapshots(env,held)).snapshots||{};}catch{}}
  const actions=clock.is_open?await managePositions(env,now,positions,orders,heldSnaps):[];
  if(!clock.is_open||!discover) return {status:actions.length?'acted':'hold',strategy:STOCK_STRATEGY,mode:'manage_only',actions};
  const {hour,minute}=etParts(now),mins=hour*60+minute; if(mins<570||mins>=950) return {status:actions.length?'acted':'hold',strategy:STOCK_STRATEGY,mode:'outside_entry_window',actions};

  const symbols=await discoverySymbols(env); if(!symbols.length) return {status:'hold',strategy:STOCK_STRATEGY,mode:'no_discovery'};
  const snap=(await fetchSnapshots(env,symbols)).snapshots||{};
  const light=symbols.map(symbol=>({symbol,...snapFields(snap[symbol]||{})})).filter(x=>x.mid>1&&x.ask>0&&x.bid>0&&x.spread<=pct(env.MAX_SPREAD_PCT,0.003)&&x.dollarVolume>=num(env.MIN_DOLLAR_VOLUME_USD,5000000)&&x.minRet>-0.002&&x.dayRet>-0.03)
    .sort((a,b)=>(b.minRet*2+b.dayRet*0.35+Math.log10(Math.max(1,b.dollarVolume))*0.0002)-(a.minRet*2+a.dayRet*0.35+Math.log10(Math.max(1,a.dollarVolume))*0.0002));
  const finalists=light.slice(0,int(env.FREE_TIER_STOCK_FINALISTS,1));
  const news=await recentNewsContext(env,finalists.map(x=>x.symbol),now,180);
  const deep=(await Promise.all(finalists.map(x=>deepCandidate(env,x.symbol,snap[x.symbol],news.get(x.symbol))))).filter(x=>x?.deepPass).sort((a,b)=>b.opportunityScore-a.opportunityScore);
  const botLots=botLotsFromOrders(orders),botPos=(positions||[]).filter(p=>botLots[p.symbol]?.qty>1e-8),maxPos=int(env.MAX_CONCURRENT_POSITIONS,2);
  if(botPos.length>=maxPos||!deep.length) return {status:actions.length?'acted':'hold',strategy:STOCK_STRATEGY,mode:'deep_research',discoveryCount:symbols.length,finalists:finalists.map(x=>x.symbol),qualified:deep.map(x=>x.symbol),actions};
  const c=deep[0]; let asset=await fetchAsset(env,c.symbol); if(!asset||asset.tradable===false||asset.fractionable===false) return {status:'hold',strategy:STOCK_STRATEGY,mode:'asset_block'};
  const equity=Math.max(1,+account.equity||1),bp=Math.max(0,+account.buying_power||0),base=Math.min(num(env.ORDER_NOTIONAL_USD,35000),num(env.MAX_POSITION_USD,35000),bp);
  const notional=Math.min(base,base*clamp(0.65+c.probability*0.55+Math.min(0.25,c.movementOpportunity*12),0.65,1));
  if(notional>=1){try{const o=await placeLimitBuy(env,c,notional,now);actions.push({action:'buy',symbol:c.symbol,reason:'free_tier_deep_research_winner',probability:round(c.probability,3),expectedNetEdge:round(c.expectedNetEdge,5),notional:round(notional,2),orderStatus:o?.status||null});}catch(e){actions.push({action:'buy_failed',symbol:c.symbol,reason:e.message});}}
  return {status:actions.length?'acted':'hold',strategy:STOCK_STRATEGY,mode:'deep_research',discoveryCount:symbols.length,finalists:finalists.map(x=>x.symbol),qualified:deep.map(x=>x.symbol),actions};
}

export function stockFreeTierStatus(env){return {strategy:STOCK_STRATEGY,endpoint:'paper',freeTier:{cpuMsPerInvocation:10,requestLimitPerDay:100000,architecture:'broad_screener_then_deep_finalists',finalists:int(env.FREE_TIER_STOCK_FINALISTS,1),alternatingMarketDiscovery:true},research:{marketWideMovers:true,marketWideMostActive:true,deepFinalistResearch:true,timeframes:['1Min','5Min','15Min','1Hour','1Day'],recentTradeTape:true,catalystAware:true,researchBeforeExecution:true,tradeVolumeObjective:false}};}

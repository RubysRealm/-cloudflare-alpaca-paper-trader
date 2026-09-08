import { marketDataRaw } from './api.js';
import { confirmCoinbaseMomentum } from './coinbase-confirm.js';
import {
  CRYPTO_STRATEGY,
  CRYPTO_PREFIX,
  runCryptoFreeTier,
  cryptoFreeTierStatus,
  cryptoOpportunityDiagnostics as coreOpportunityDiagnostics,
  cryptoExecutionDirective as coreExecutionDirective
} from './quant-crypto-v24.js';

export { CRYPTO_STRATEGY, CRYPTO_PREFIX, runCryptoFreeTier, cryptoFreeTierStatus };

const HEALTH_SYMBOLS=['BTC/USD','ETH/USD','SOL/USD'];

function snapshotMid(s={}){
  const q=s.latestQuote||s.latest_quote||{};
  const bid=+(q.bp??q.bid_price??0),ask=+(q.ap??q.ask_price??0);
  return bid>0&&ask>0?(bid+ask)/2:0;
}

async function marketDataHealth(env,now){
  let snaps={};
  try{
    const d=await marketDataRaw(env,`/v1beta3/crypto/us/snapshots?symbols=${HEALTH_SYMBOLS.map(encodeURIComponent).join(',')}`);
    snaps=d?.snapshots||d||{};
  }catch{}
  const checks=[];
  for(const symbol of HEALTH_SYMBOLS){
    const mid=snapshotMid(snaps[symbol]||{});
    const x=await confirmCoinbaseMomentum(env,{symbol,mid},now);
    checks.push({
      symbol,
      alpacaMid:mid,
      available:Boolean(x.available),
      pass:Boolean(x.pass),
      error:x.error||null,
      price:x.price||0,
      spread:x.spread,
      dollarVolume24:x.dollarVolume24||0,
      depthWithin20bps:x.depthWithin20bps||0,
      bidDepthWithin20bps:x.bidDepthWithin20bps||0,
      askDepthWithin20bps:x.askDepthWithin20bps||0,
      orderBookImbalance:x.orderBookImbalance,
      aggressiveBuySellRatio:x.aggressiveBuySellRatio,
      cvdUsd:x.cvdUsd||0,
      rvol15:x.rvol15||0,
      rvol60:x.rvol60||0,
      atrExpansion:x.atrExpansion||0,
      bbWidthExpansion:x.bbWidthExpansion||0,
      priceDivergence:x.priceDivergence,
      reasons:x.reasons||[]
    });
  }
  return{
    provider:'coinbase_exchange',
    symbols:checks,
    availableCount:checks.filter(x=>x.available).length,
    allUnavailable:checks.every(x=>!x.available)
  };
}

export async function cryptoOpportunityDiagnostics(env,now=Date.now()){
  const d=await coreOpportunityDiagnostics(env,now);
  const candidateHealth=(d.candidates||[]).map(c=>({
    symbol:c.symbol,
    available:Boolean(c.coinbase?.available),
    pass:Boolean(c.coinbase?.pass),
    spread:c.coinbase?.spread,
    dollarVolume24:c.coinbase?.dollarVolume24||0,
    depthWithin20bps:c.coinbase?.depthWithin20bps||0,
    orderBookImbalance:c.coinbase?.orderBookImbalance,
    aggressiveBuySellRatio:c.coinbase?.aggressiveBuySellRatio,
    cvdUsd:c.coinbase?.cvdUsd||0
  }));
  d.marketDataHealth=candidateHealth.some(x=>x.available)
    ? {provider:'coinbase_exchange',symbols:candidateHealth,availableCount:candidateHealth.filter(x=>x.available).length,allUnavailable:false,source:'deep_candidates'}
    : {...await marketDataHealth(env,now),source:'liquid_reference_pairs'};
  return d;
}

export async function cryptoExecutionDirective(env,now=Date.now()){
  return coreExecutionDirective(env,now);
}

export const STRATEGY='intraday-adaptive-v8.1';
export const BOT_PREFIXES=['paper-','paper8-'];
export const TECH=new Set(['QQQ','XLK','SMH','SOXX','NVDA','AAPL','TSLA','AMD','AMZN','META','MSFT','GOOGL','GOOG','AVGO','NFLX','CRM','ORCL','INTC','MU','QCOM','ARM','PLTR']);
export const num=(v,f)=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:f};
export const pct=(v,f)=>{const n=Number(v);return Number.isFinite(n)&&n>0&&n<1?n:f};
export const int=(v,f)=>{const n=Number(v);return Number.isInteger(n)&&n>0?n:f};
export const bool=(v,f=false)=>v===undefined||v===null||v===''?f:String(v).toLowerCase()==='true';
export const clamp=(x,l,h)=>Math.max(l,Math.min(h,x));
export const round=(x,p=4)=>{const q=10**p;return Math.round(Number(x)*q)/q};
export const isBotOrder=o=>BOT_PREFIXES.some(p=>String(o?.client_order_id||'').startsWith(p));
export function etParts(time){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(time));const g=t=>Number(parts.find(p=>p.type===t)?.value||0);return{year:g('year'),month:g('month'),day:g('day'),hour:g('hour'),minute:g('minute')}}
export function etDateKey(time){const p=etParts(time);return`${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`}
export function entryWindowOpen(time){const{hour,minute}=etParts(time),m=hour*60+minute;return(m>=580&&m<=695)||(m>=800&&m<=910)}
export function inConfiguredBlackout(env,time){const raw=String(env.EVENT_BLACKOUT_WINDOWS_ET||'').trim();if(!raw)return false;const{hour,minute}=etParts(time),now=hour*60+minute;return raw.split(',').some(w=>{const[a,b]=w.trim().split('-');if(!a||!b)return false;const cv=s=>{const[h,m]=s.split(':').map(Number);return h*60+m};return now>=cv(a)&&now<=cv(b)})}
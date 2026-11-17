import { loadInstalledCustomApps } from './custom-app-storage';
import { createOrGetSession, loadChatMessages, type ChatMessage } from './chat-storage';
const string=(v:unknown,n=4000)=>typeof v==='string'?v.trim().slice(0,n):'';
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'?v as Record<string,unknown>:{};
export function cardSchedule(rows:Array<{label:string;value:string}>,body:string,placementYear:number) {
  const labels=rows.filter(r=>/时间|日期|日程|举办|出发|开放|行期/.test(r.label)).map(r=>r.value);
  const raw=labels.join('；') || (body.match(/\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?|(?:\d{4}年)?(?:年底|年末|年终)|\d{1,2}月\d{1,2}日/)?.[0] || '');
  const explicitYear=raw.match(/(\d{4})年?/)?.[1];
  const year=explicitYear?Number(explicitYear):placementYear;
  let date='',note='';
  const exact=raw.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  const monthDay=raw.match(/(\d{1,2})月(\d{1,2})日/);
  const pad=(n:number)=>String(n).padStart(2,'0');
  if(exact)date=`${exact[1]}-${pad(Number(exact[2]))}-${pad(Number(exact[3]))}`;
  else if(/年底|年末|年终/.test(raw)){date=`${year}-12-31`;note='“年底”放在该年12月31日作为日历占位；剧情仍按“年底”，不声称活动在31日举行。';}
  else if(monthDay){date=`${year}-${pad(Number(monthDay[1]))}-${pad(Number(monthDay[2]))}`;note=explicitYear?'':'卡片未注明年份，按当前日历年份定位；剧情保留卡片原始时间。';}
  else {const month=raw.match(/(\d{1,2})月/);if(month&&Number(month[1])<=12){date=`${year}-${pad(Number(month[1]))}-01`;note='只标明月份，月初日期仅作日历占位，不是活动确切日期。';}}
  if(date){const check=new Date(date+'T12:00:00Z');if(Number.isNaN(check.getTime())||check.toISOString().slice(0,10)!==date)date='';}
  const time=raw.match(/(?:^|\D)([01]?\d|2[0-3])[:：]([0-5]\d)(?:\D|$)/);
  return {sourceTimeLabel:raw,calendarDate:date,cardTime:time?`${pad(Number(time[1]))}:${time[2]}`:'',calendarNote:note||'卡片时间用于日历展示，不限制何时进入副本。'};
}
export function loadFrequencySources(characterId:string,calendarYear:number) {
  const apps=loadInstalledCustomApps();
  const allowed=new Set(apps.filter(a=>a.manifest.id==='sabina.frequency').map(a=>a.id));
  const session=createOrGetSession(characterId);const all=loadChatMessages(session.id);
  const isSource=(m:ChatMessage)=>m.mediaType==='app_card'&&allowed.has(String(m.mediaData?.appId||''));
  const result=[];
  for(let i=all.length-1;i>=0&&result.length<80;i--){const m=all[i];if(!isSource(m))continue;
    const media=m.mediaData,layout=record(media?.appCardLayout),meta=record(layout.frequencySource);
    const sections=Array.isArray(layout.sections)?layout.sections:[];
    const rows=sections.flatMap(v=>{const r=record(v);return Array.isArray(r.rows)?r.rows:[]}).map(v=>{const r=record(v);return {label:string(r.label,60),value:string(r.value,500)}});
    const body=string(layout.body||media?.appCardBody||media?.appCardSummary);
    let end=all.length;for(let j=i+1;j<all.length;j++){if(isSource(all[j])){end=j;break;}}
    result.push({cardMessageId:m.id,sessionId:session.id,signalId:string(media?.appSceneId||meta.id,160)||m.id,appId:media?.appId,title:string(layout.title||media?.appCardTitle,160),body,rows,...cardSchedule(rows,body+'\n'+string(media?.appHistoryText||m.content,12000),calendarYear),followup:all.slice(i+1,end).slice(-120).map(v=>({id:v.id,role:v.role,content:string(v.mediaData?.appHistoryText||v.content,6000),createdAt:v.createdAt}))});
  }
  return result;
}

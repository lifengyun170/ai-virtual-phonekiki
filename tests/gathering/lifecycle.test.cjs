const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, flush } = require('./loader.cjs');
function setup({ chance = 0, plan = { contact: false, delaySeconds: 0 }, delayedStory = false } = {}) {
  let now = 2_000_000, timer, ids=0, resolveStory;
  const kv=new Map(), timeline=[], calls={plans:[],sends:[],moments:[],prompts:[]}, sessions=[];
  const app={id:'installed-app',name:'兄弟局',permissions:['gathering.manage']};
  const window=new EventTarget();
  const story=JSON.stringify({story:'夜'.repeat(1400),summary:'朋友们在茶馆相聚，聊起旧事，告别后各自回家。'});
  const mocks={
    './kv-db':{kvGet:k=>kv.get(k)||null,kvSet:(k,v)=>kv.set(k,v),registerKvMigration(){}},
    './bg-timer':{bgSetInterval:fn=>{timer=fn;return()=>{timer=null;};}},
    './character-storage':{loadCharacters:()=>[{id:'A'},{id:'B'}]},
    './chat-storage':{loadChatContacts:()=>[{characterId:'A'},{characterId:'B'}],addChatContact(){},loadChatSessions:()=>sessions,
      createOrGetSession:id=>{let s=sessions.find(s=>s.contactId===id);if(!s){s={id:'session-'+id,contactId:id};sessions.push(s);}return s;}},
    './custom-app-storage':{loadInstalledCustomApps:()=>[app],loadCustomAppTimelineEntries:id=>timeline.filter(x=>x.characterId===id),
      appendCustomAppTimelineEntry:(a,e)=>timeline.push({...e,appId:a.id,data:{...e.data,appEventId:e.appEventId}})},
    './gathering-prompt':{parseGatheringJson:JSON.parse,validateGatheringOutput:async()=>{},generateGatheringTask:async(s,p)=>{
      calls.prompts.push({s,p});if(delayedStory)return new Promise(r=>resolveStory=()=>r(story));return story;
    }},
    './follow-up-service':{planGatheringContact:async(s,c)=>{calls.plans.push({s,c});return plan;},
      sendGatheringContact:async(s,c,signal,current)=>{if(signal.aborted||!current())return 'cancelled';calls.sends.push({s,c});return 'sent';}},
    './moments-engine':{requestGatheringMoment:async(id,e)=>{calls.moments.push({id,e});return 'done';}}
  };
  class FakeDate extends Date {constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
  const MathMock=Object.create(Math);MathMock.random=()=>chance;
  const globals={window,navigator:{},crypto:{randomUUID:()=>`event-${++ids}`},Date:FakeDate,Math:MathMock};
  const svc=load('lib/gathering-service.ts',mocks,globals);svc.startGatheringService();
  const invoke=(action,input={},a=app)=>svc.handleGatheringRequest(a,'gathering.'+action,{characterId:'A',...input});
  const start=async(extra={})=>{const e=await invoke('start',{date:'2099-12-31',location:'茶馆',activity:'叙旧',participants:['朋友甲'],...extra});await flush();return e;};
  const tick=async(ms=5000)=>{now+=ms;timer?.();await flush();};
  return {svc,invoke,start,tick,calls,timeline,kv,app,globals,mocks,flush,finishStory:()=>resolveStory?.(),advance:ms=>{now+=ms;}};
}
test('future date starts immediately; host survives iframe absence; random may produce no contact',async()=>{
 const f=setup({chance:.9});const e=await f.start();assert.equal(e.status,'active');
 for(let i=0;i<240;i++)await f.tick();
 const state=await f.invoke('status');assert.equal(state.events[0].trials,3);assert.equal(f.calls.plans.length,0);
 assert.equal(state.events[0].status,'active');assert.equal(f.timeline.length,0);assert.equal(f.calls.moments.length,0);
});
test('random opportunity delegates native content, and end cancels delayed active message',async()=>{
 const f=setup({plan:{contact:true,delaySeconds:300}});const e=await f.start();
 for(let i=0;i<25;i++)await f.tick();assert.equal(f.calls.plans.length,1);assert.equal(f.calls.sends.length,0);
 await f.invoke('end',{eventId:e.id});await f.flush();
 assert.equal(f.timeline.length,1);assert.equal(f.calls.moments.length,1);
 for(let i=0;i<61;i++)await f.tick();
 assert.equal(f.calls.sends.length,1);assert.match(f.calls.sends[0].c,/聚会已由User点击结束/);
});
test('repeated starts and end clicks are idempotent; current-character short memory only',async()=>{
 const f=setup();const e=await f.start();const same=await f.start();assert.equal(e.id,same.id);
 await f.invoke('end',{eventId:e.id});await f.invoke('end',{eventId:e.id});await f.flush();
 assert.equal(f.timeline.length,1);assert.equal(f.timeline[0].characterId,'A');assert.equal(f.timeline[0].data.shortTermOnly,true);
 assert.equal(f.calls.moments.length,1);assert.equal(f.calls.plans.length,1);assert.equal(f.calls.sends.length,0);
});
test('cross-character/app requests cannot end or read another line',async()=>{
 const f=setup();const e=await f.start();await f.start({characterId:'B'});
 await assert.rejects(f.invoke('end',{characterId:'B',eventId:e.id}),/不属于/);
 await assert.rejects(f.invoke('end',{eventId:e.id},{...f.app,id:'other-app'}),/不属于/);
 const b=await f.invoke('status',{characterId:'B'});assert.equal(b.events.length,1);assert.equal(b.events[0].characterId,'B');
 assert.ok(f.calls.prompts.every(c=>c.s==='session-A'||c.s==='session-B'));
});
test('end during story generation aborts without memory or social side effects',async()=>{
 const f=setup({delayedStory:true});const e=await f.start();await f.invoke('end',{eventId:e.id});f.finishStory();await f.flush();
 const state=await f.invoke('status');assert.equal(state.events[0].story,'');assert.equal(state.events[0].status,'ended');
 assert.equal(f.timeline.length,0);assert.equal(f.calls.moments.length,0);assert.equal(f.calls.sends.length,0);
});
test('reload does not replay missed active opportunities or ended social tasks',async()=>{
 const f=setup({plan:{contact:true,delaySeconds:300}});const e=await f.start();await f.invoke('end',{eventId:e.id});await f.flush();
 f.svc.stopGatheringService();f.advance(86400000);
 const restarted=load('lib/gathering-service.ts',f.mocks,f.globals);restarted.startGatheringService();await f.tick();
 const state=await restarted.handleGatheringRequest(f.app,'gathering.status',{characterId:'A'});
 assert.equal(state.events[0].contactState,'interrupted');assert.equal(f.calls.sends.length,0);assert.equal(f.calls.plans.length,1);
});
test('long suspended tick is skipped, not a catch-up trigger',async()=>{
 const f=setup({plan:{contact:true,delaySeconds:0}});await f.start();await f.tick(3600000);assert.equal(f.calls.plans.length,0);
 await f.tick();assert.equal(f.calls.plans.length,0);
});
test('active contact can be generated without iframe; native chooses no contact too',async()=>{
 const f=setup({plan:{contact:true,delaySeconds:0}});await f.start();for(let i=0;i<25;i++)await f.tick();
 assert.equal(f.calls.sends.length,1);assert.match(f.calls.sends[0].c,/聚会正在进行/);assert.equal(f.timeline.length,0);
});
test('permission is enforced at service boundary',async()=>{
 const f=setup();await assert.rejects(f.invoke('start',{}, {...f.app,permissions:[]}),/权限/);
});

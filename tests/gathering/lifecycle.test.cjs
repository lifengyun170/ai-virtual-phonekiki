const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, flush } = require('./loader.cjs');
function setup({ chance = 0, plan = { contact: false, delaySeconds: 0 }, delayedStory = false, projection = async () => "同行者亲眼见到朋友们在茶馆聚会。" } = {}) {
  let now = 2_000_000, timer, ids=0, resolveStory;
  const kv=new Map(), timeline=[], calls={plans:[],sends:[],moments:[],prompts:[],projections:[]}, sessions=[];
  const app={id:'installed-app',name:'兄弟局',permissions:['gathering.manage']};
  const window=new EventTarget();
  const story=JSON.stringify({story:'夜'.repeat(1400),summary:'朋友们在茶馆相聚，聊起旧事，告别后各自回家。'});
  const mocks={
    './kv-db':{kvGet:k=>kv.get(k)||null,kvSet:(k,v)=>kv.set(k,v),registerKvMigration(){}},
    './bg-timer':{bgSetInterval:fn=>{timer=fn;return()=>{timer=null;};}},
    './character-storage':{loadCharacters:()=>[{id:'A',name:'主角'},{id:'B',name:'同行男主'},{id:'C',name:'未参加男主'}]},
    './chat-storage':{loadChatContacts:()=>[{characterId:'A'},{characterId:'B'}],addChatContact(){},loadChatSessions:()=>sessions,
      createOrGetSession:id=>{let s=sessions.find(s=>s.contactId===id);if(!s){s={id:'session-'+id,contactId:id};sessions.push(s);}return s;}},
    './custom-app-storage':{loadInstalledCustomApps:()=>[app],loadCustomAppTimelineEntries:id=>timeline.filter(x=>x.characterId===id),
      appendCustomAppTimelineEntry:(a,e)=>timeline.push({...e,appId:a.id,data:{...e.data,appEventId:e.appEventId}})},
    './gathering-prompt':{parseGatheringJson:JSON.parse,validateGatheringOutput:async()=>{},generateGatheringTask:async(s,p)=>{
      calls.prompts.push({s,p});if(delayedStory)return new Promise(r=>resolveStory=()=>r(story));return story;
    }},
    './gathering-participant-memory':{...load('lib/gathering-participant-memory.ts'),projectGatheringParticipantMemory:async(...args)=>{calls.projections.push(args);return projection(...args);}},
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

test('explicitly bound attendee gets own short-term memory; unbound characters and NPC do not',async()=>{
 const f=setup();const e=await f.start({participantCharacterIds:['B','B'],participants:['世界书NPC']});
 assert.equal(f.timeline.length,0);await f.invoke('end',{eventId:e.id});await f.flush();
 assert.equal(f.timeline.length,2);assert.equal(f.timeline.map(e=>e.characterId).sort().join(','),'A,B');
 assert.equal(f.timeline.find(e=>e.characterId==='B').data.shortTermOnly,true);
 assert.equal(f.calls.projections.length,1);assert.equal(f.calls.projections[0][2],'同行男主');
 assert.ok(!f.calls.projections[0][1].includes('session-A'));
 await f.invoke('end',{eventId:e.id});await f.invoke('retryMemories',{eventId:e.id});await f.flush();assert.equal(f.timeline.length,2);
});
test('same name written as NPC alone never implicitly binds a character',async()=>{
 const f=setup();const e=await f.start({participants:['同行男主']});await f.invoke('end',{eventId:e.id});await f.flush();
 assert.equal(f.timeline.length,1);assert.equal(f.calls.projections.length,0);
});
test('selected character absent from actual story receives no memory',async()=>{
 const f=setup({projection:async()=>null});const e=await f.start({participantCharacterIds:['B']});await f.invoke('end',{eventId:e.id});await f.flush();
 assert.equal(f.timeline.length,1);const state=await f.invoke('status');assert.equal(state.events[0].participantMemories[0].state,'skipped');
});
test('failed participant projection is isolated and retry does not repeat owner memory or social effects',async()=>{
 let fail=true;const f=setup({projection:async()=>{if(fail)throw Error('API failed');return '同行者听见朋友讲述当场的趣事。';}});
 const e=await f.start({participantCharacterIds:['B']});await f.invoke('end',{eventId:e.id});await f.flush();
 assert.equal((await f.invoke('status')).events[0].participantMemories[0].state,'error');assert.equal(f.timeline.length,1);
 fail=false;await f.invoke('retryMemories',{eventId:e.id});await f.flush();assert.equal(f.timeline.length,2);assert.equal(f.calls.moments.filter(c=>c.id==='A').length,1);assert.equal(f.calls.plans.filter(c=>c.s==='session-A').length,1);assert.equal(f.calls.moments.filter(c=>c.id==='B').length,1);
});
test('invalid character ID and owner duplication are rejected before starting',async()=>{
 const f=setup();await assert.rejects(f.start({participantCharacterIds:['missing']}),/不存在/);await assert.rejects(f.start({participantCharacterIds:['A']}),/自动参加/);assert.equal((await f.invoke('status')).events.length,0);
});
test('closing page during participant projection prevents late write; reload requires explicit retry',async()=>{
 let resolve;const f=setup({projection:()=>new Promise(r=>resolve=r)});const e=await f.start({participantCharacterIds:['B']});await f.invoke('end',{eventId:e.id});await f.flush();
 f.svc.stopGatheringService();resolve('迟到摘要');await f.flush();assert.equal(f.timeline.length,1);
 f.svc.startGatheringService();const state=await f.invoke('status');assert.equal(state.events[0].participantMemories[0].state,'interrupted');
});

test('participants use the same active scheduler, own native session, and only projected context',async()=>{
 const shared='同行男主当场听见朋友讲趣事';const f=setup({plan:{contact:true,delaySeconds:0},projection:async()=>shared});
 await f.start({participantCharacterIds:['B']});for(let i=0;i<25;i++)await f.tick();
 const mine=f.calls.sends.filter(c=>c.s==='session-A'), theirs=f.calls.sends.filter(c=>c.s==='session-B');
 assert.equal(mine.length,1);assert.equal(theirs.length,1);assert.match(theirs[0].c,/同行男主当场听见/);assert.ok(!theirs[0].c.includes('夜'.repeat(10)));assert.equal(f.timeline.length,0);
});
test('end cancels ALL active send plans; each participant gets own end chat/moments decision once',async()=>{
 const f=setup({plan:{contact:true,delaySeconds:300}});const e=await f.start({participantCharacterIds:['B']});
 for(let i=0;i<25;i++)await f.tick();assert.equal(f.calls.plans.length,2);assert.equal(f.calls.sends.length,0);
 await f.invoke('end',{eventId:e.id});await f.flush();assert.equal(f.calls.moments.map(c=>c.id).sort().join(','),'A,B');
 assert.notEqual(f.calls.moments[0].e.eventId,f.calls.moments[1].e.eventId);
 for(let i=0;i<61;i++)await f.tick();assert.equal(f.calls.sends.length,2);assert.ok(f.calls.sends.every(c=>c.c.includes('聚会已由User点击结束')));
 await f.invoke('end',{eventId:e.id});await f.invoke('retryMemories',{eventId:e.id});await f.flush();assert.equal(f.calls.moments.length,2);assert.equal(f.calls.sends.length,2);
});
test('absent or unbound participants receive no social actions',async()=>{
 const f=setup({projection:async()=>null,plan:{contact:true,delaySeconds:0}});const e=await f.start({participantCharacterIds:['B'],participants:['未参加男主']});
 for(let i=0;i<25;i++)await f.tick();await f.invoke('end',{eventId:e.id});await f.flush();
 assert.ok(f.calls.sends.every(c=>c.s==='session-A'));assert.ok(f.calls.moments.every(c=>c.id==='A'));
});
test('reopen never replays participant end messages, including after explicit memory retry',async()=>{
 const f=setup({plan:{contact:true,delaySeconds:300}});const e=await f.start({participantCharacterIds:['B']});await f.invoke('end',{eventId:e.id});await f.flush();
 f.svc.stopGatheringService();f.advance(86400000);f.svc.startGatheringService();await f.invoke('retryMemories',{eventId:e.id});for(let i=0;i<65;i++)await f.tick();
 assert.equal(f.calls.sends.length,0);assert.equal(f.calls.moments.length,2);
 const p=(await f.invoke('status')).events[0].participantMemories[0];assert.equal(p.social.contactState,'interrupted');
});
test('participant virtual actor cannot be ended through public SDK',async()=>{
 const f=setup();const e=await f.start({participantCharacterIds:['B']});await assert.rejects(f.invoke('end',{characterId:'B',eventId:e.id+':participant:B'}),/不存在|不属于/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, flush } = require('./loader.cjs');
function nativeChat({ delayedValidation=false, image=false }={}) {
 const writes=[],photos=[];let resolveValidation;
 const window=new EventTarget();
 const mocks={
  './chat-storage':{loadChatSessions:()=>[{id:'sA',contactId:'A'}],loadChatMessages:()=>[],getLatestCharacterStateValues:()=>[],
   createResponseBatchId:()=> 'batch',pushChatMessage:m=>{const v={id:'m'+writes.length,...m};writes.push(v);return v;}},
  './character-storage':{loadCharacters:()=>[{id:'A',name:'男主'}]},
  './kv-db':{kvGet:()=>null},
  './gathering-prompt':{generateGatheringTask:async()=>image?'[照片:窗边的茶杯]':'刚才聊起了一件趣事。',
   validateGatheringOutput:()=>delayedValidation?new Promise(r=>resolveValidation=r):Promise.resolve()},
  './rich-message-parser':{parseAIResponse:text=>({parts:[image?{content:'',mediaType:'image',mediaData:{label:'窗边的茶杯'}}:{content:text}],stateValues:[],freshStateValues:[],statusPanel:'',innerMonologue:''})},
  './generated-image-retry':{createPendingChatGeneratedImageData:(d)=>({...d,pending:true}),isPendingChatGeneratedImageMessage:m=>m.mediaData?.pending===true,
   generateAndApplyChatGeneratedImage:async(m,id)=>photos.push({m,id})},
  './bg-timer':{bgSetTimeout:fn=>{fn();return()=>{};}},
 };
 return {api:load('lib/follow-up-service.ts',mocks,{window}),writes,photos,finish:()=>resolveValidation?.()};
}
test('native parser receives AI result and writes only assistant messages with provenance',async()=>{
 const f=nativeChat();const c=new AbortController();const result=await f.api.sendGatheringContact('sA','event',c.signal,()=>true,'eA');
 assert.equal(result,'sent');assert.equal(f.writes.length,1);assert.equal(f.writes[0].role,'assistant');assert.equal(f.writes[0].gatheringEventId,'eA');
});
test('end while native validation is in flight prevents any message insertion',async()=>{
 const f=nativeChat({delayedValidation:true});const c=new AbortController();let active=true;
 const pending=f.api.sendGatheringContact('sA','event',c.signal,()=>active,'eA');await flush();active=false;c.abort();f.finish();
 assert.equal(await pending,'cancelled');assert.equal(f.writes.length,0);
});
test('photo output reaches the existing native image generation path',async()=>{
 const f=nativeChat({image:true});const c=new AbortController();await f.api.sendGatheringContact('sA','event',c.signal,()=>true,'eA');
 assert.equal(f.writes[0].mediaType,'image');assert.equal(f.photos.length,1);assert.equal(f.photos[0].id,'A');
});
function moments(publish, { failValidation=false }={}) {
 const posts=[],requests=[],scopes=[],summaries=[];
 const mocks={
  './character-storage':{loadCharacters:()=>[{id:'A',name:'男主'}]},
  './chat-storage':{loadChatContacts:()=>[{characterId:'A'},{characterId:'B'}]},
  './settings-storage':{loadBindingConfig:()=>({}),resolveBinding:()=>({apiConfigId:'api',worldBookIds:['own']}),
   loadApiConfigs:()=>[{id:'api'}],loadPresets:()=>[{builtIn:true}],loadWorldBooks:()=>[{id:'own'}],loadRegexes:()=>[],resolveUserIdentity:()=>({name:'UserSecret'})},
  './memory-storage':{loadMemoryConfig:()=>({}),incrementEventCounter:()=>summaries.push('counter')},
  './memory-service':{retrieveCoreMemoriesForPrompt:async()=>[],retrieveMemoriesForPrompt:async()=>[]},
  './memory-injector':{formatCoreMemories:()=>'',formatLongTermMemories:()=>''},
  './short-term-assembler':{prepareShortTermContext:(id,app,opts)=>{scopes.push({id,opts});return {recentBlocks:[],unifiedRecentItems:[],wbActivationContext:''};}},
  './moments-storage':{loadMomentPosts:()=>posts,updateScheduleAfterPost(){},loadMomentsConfig:()=>({}),findRecentDuplicateMomentPost:()=>null,
   addMomentPost:p=>{const result={id:'post1',...p};posts.push(result);return result;}},
  './llm-prompt-assembler':{assemblePromptPayload:input=>{assert.equal(input.character.id,'A');assert.equal(input.activateAllWorldBooks,true);return[];}},
  './chat-engine':{sendLLMRequest:async(...args)=>{requests.push(args);return requests.length===1?JSON.stringify({publish}):'[朋友圈]和老朋友喝了杯茶。[/朋友圈]';}},
  './gathering-prompt':{GATHERING_RULES:'测试规则',parseGatheringJson:JSON.parse},
  './action-parser':{parseActionTags:text=>({cleanText:text,actions:[]})},
  './memory-summarizer':{maybeRunSummarization:()=>{summaries.push('long-term');return Promise.resolve();}},
 };
 const api=load('lib/moments-engine.ts',mocks,{window:new EventTarget()});
 const event={eventId:'eA',context:'event facts',signal:new AbortController().signal,validate:async()=>{if(failValidation)throw Error('unsafe');}};
 return{api,event,posts,requests,scopes,summaries};
}
test('native moments decision can decline without any post',async()=>{
 const f=moments(false);await f.api.requestGatheringMoment('A',f.event);assert.equal(f.posts.length,0);assert.equal(f.requests.length,1);
});
test('native moments generates then inserts scoped post once; does not trigger long-term summarization',async()=>{
 const f=moments(true);await f.api.requestGatheringMoment('A',f.event);await f.api.requestGatheringMoment('A',f.event);
 assert.equal(f.requests.length,2);assert.equal(f.posts.length,1);assert.equal(f.posts[0].lineCharacterId,'A');
 assert.equal(f.posts[0].visibility.join(','),'A');assert.equal(f.posts[0].gatheringEventId,'eA');assert.equal(f.summaries.length,0);
 assert.ok(f.scopes.every(x=>x.id==='A'&&x.opts.strictCharacterScope));
});
test('native moments validation failure does not publish',async()=>{
 const f=moments(true,{failValidation:true});await assert.rejects(f.api.requestGatheringMoment('A',f.event),/unsafe/);assert.equal(f.posts.length,0);
});
test('native summary formatter excludes gathering short-term-only events',()=>{
 const api=load('lib/short-term-assembler.ts',{'./prompt-time':{resolvePromptTimeAware:()=>true}});
 const result=api.formatTimelineForSummarization([{id:'private',shortTermOnly:true,timestamp:'2026-01-01',content:'兄弟局'},
  {id:'normal',timestamp:'2026-01-02',content:'正常事件'}],{timeAware:true});
 assert.equal(result.count,1);assert.equal(result.eventsText,'- 正常事件');
});
test('cross-line native moments visibility and interaction are denied, even in same world',()=>{
 const api=load('lib/character-world-storage.ts');const post={authorType:'character',authorId:'A',lineCharacterId:'A',visibility:['A','B']};
 assert.equal(api.canCharacterSeeMomentPost(post,'B'),false);assert.equal(api.isMomentRealCharacterAllowedForPost(post,'B'),false);
 assert.equal(api.canCharacterSeeMomentPost(post,'A'),true);
});
test('exact User name and occupation are rejected before semantic audit',async()=>{
 let calls=0;const api=load('lib/gathering-prompt.ts',{
  './chat-storage':{loadChatSessions:()=>[{id:'sA',contactId:'A'}]},
  './settings-storage':{resolveUserIdentity:()=>({name:'私密姓名',occupation:'私密职业'})},
  './chat-engine':{buildChatPromptMessages:()=>{calls++;throw Error('should not run');}}
 });
 await assert.rejects(api.validateGatheringOutput('sA','他的恋人叫私密姓名'),/身份|姓名/);
 await assert.rejects(api.validateGatheringOutput('sA','她从事私密职业'),/职业/);assert.equal(calls,0);
});

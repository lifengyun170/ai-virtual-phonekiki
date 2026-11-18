const {test}=require('node:test');const assert=require('node:assert/strict');const {load}=require('./loader.cjs');
test('projection transmits only story and observer, never assembled private prompt or histories',async()=>{
 const requests=[];const api=load('lib/gathering-participant-memory.ts',{
 './chat-storage':{loadChatSessions:()=>[{id:'sA',contactId:'A'}]},
 './chat-engine':{buildChatPromptMessages:async()=>({config:{},preset:{},llmMessages:[{role:'system',content:'HOST_PRIVATE_MEMORY_SECRET'}],regexes:[]}),
 sendLLMRequest:async(c,p,m)=>{requests.push(m);return requests.length===1?JSON.stringify({attended:true,evidence:['同行男主推门进来'],summary:'同行男主来到茶馆，听见朋友说你好。'}):'{"safe":true}';}},
 './gathering-prompt':{parseGatheringJson:JSON.parse}
 });
 const result=await api.projectGatheringParticipantMemory('sA','同行男主推门进来，朋友当面说你好。','同行男主',new AbortController().signal);
 assert.match(result,/来到茶馆/);assert.equal(requests.length,2);assert.ok(!JSON.stringify(requests).includes('HOST_PRIVATE_MEMORY_SECRET'));
});
test('invented evidence and unsafe perspective are refused',async()=>{
 for(const mode of ['invented','unsafe']){let calls=0;const api=load('lib/gathering-participant-memory.ts',{
 './chat-storage':{loadChatSessions:()=>[{id:'sA'}]},'./chat-engine':{buildChatPromptMessages:async()=>({config:{},preset:{}}),sendLLMRequest:async()=>++calls===1?JSON.stringify({attended:true,evidence:[mode==='invented'?'不存在的场景':'同行者在场'],summary:'观察摘要'}):'{"safe":false}'},'./gathering-prompt':{parseGatheringJson:JSON.parse}});
 await assert.rejects(api.projectGatheringParticipantMemory('sA','同行者在场','同行者',new AbortController().signal),/证据|复核/);
 }
});
test('duplicate character names are not guessed',()=>{
 const api=load('lib/gathering-participant-memory.ts');assert.throws(()=>api.bindGatheringParticipants(['B'],'A',[{id:'A',name:'主角'},{id:'B',name:'同名'},{id:'C',name:'同名'}]),/重名/);
});

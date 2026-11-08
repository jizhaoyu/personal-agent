const {test}=require('node:test');
const assert=require('node:assert/strict');
const {checkSingle,checkSession,createFixture,runCase,parseArgs,createModelProvider,selectJobs}=require(require('node:path').join(process.cwd(),'scripts/evaluate-personal-agent.cjs'));

const record={id:'t',space:'life',title:'交电费',status:'pending',revision:1,createdAt:1,updatedAt:1};
test('creation corpus has no preexisting duplicate; mutation corpus retains its target',()=>{
 const {singles}=require('./agent-language-corpus.cjs');
 for(const sample of singles){if(sample.expected.created>0)assert.equal(sample.seed.length,0,sample.id);if(sample.expected.changed>0)assert.equal(sample.seed.length,1,sample.id);}
});
test('oracle checks persisted state and provenance, not assistant assurances',()=>{
 const sample={space:'life',text:'明天下午三点提醒我交电费',expected:{created:1,pending:1,timed:true}};
 const observed={created:[record],changed:[],needsReview:false};
 assert.ok(checkSingle(sample,observed,[record]).some(x=>x.includes('dueAt')));
 assert.ok(checkSingle({...sample,expected:{created:1,pending:1,timed:false}},observed,[{...record,status:'completed'}]).some(x=>x.includes('pending')));
 assert.ok(checkSingle({...sample,expected:{created:1}},observed,[{...record,sourceKind:'invented'}]).some(x=>x.includes('source')));
});
test('session oracle checks exact final record and terminal status counts',()=>{
 assert.deepEqual(checkSession({expected:{records:1,completed:0,cancelled:0}},[record]),[]);
 assert.equal(checkSession({expected:{records:2,completed:1,cancelled:0}},[record]).length,2);
});
test('session oracle checks final titles, times and statuses independently of count matches',()=>{
 const sample={space:'life',expected:{records:1,completed:0,cancelled:0,finalRecords:[{title:'交电费',status:'pending',dueAt:'2026-11-06T07:00:00.000Z'}]}};
 assert.ok(checkSession(sample,[record]).some(e=>e.includes('finalRecords')));
 assert.deepEqual(checkSession(sample,[{...record,dueAt:'2026-11-06T07:00:00.000Z'}]),[]);
});
test('session oracle accepts essential title keywords but never relaxes dueAt or status',()=>{
 const sample={space:'life',expected:{records:1,completed:0,cancelled:0,finalRecords:[{titleIncludes:['电费'],status:'pending',dueAt:null}]}};
 assert.deepEqual(checkSession(sample,[{...record,title:'缴纳本月电费'}]),[]);
 assert.ok(checkSession(sample,[{...record,dueAt:'2026-11-06T07:00:00.000Z'}]).length);
 assert.ok(checkSession(sample,[{...record,title:'交水费'}]).length);
});
test('timestamps compare exact instants rather than equivalent ISO timezone spellings',()=>{
 const expected='2026-11-07T08:00:00.000Z',actual='2026-11-07T16:00:00+08:00';
 const changed={...record,dueAt:actual};
 assert.deepEqual(checkSingle({space:'life',expected:{created:0,changed:1,dueAt:expected}},{created:[],changed:[changed]},[changed]),[]);
 assert.deepEqual(checkSession({space:'life',expected:{records:1,finalRecords:[{title:'交电费',dueAt:expected}]}},[changed]),[]);
 assert.ok(checkSession({space:'life',expected:{records:1,finalRecords:[{dueAt:expected}]}},[{...record,dueAt:'2026-11-07T16:01:00+08:00'}]).length);
});
test('retry job selection uses only failed original mode/id pairs and does not mutate its source',()=>{
 const corpus={singles:[{id:'a'},{id:'b'}],sessions:[{id:'c'}]},source={status:'complete',results:[{id:'a',mode:'model',pass:true},{id:'b',mode:'model',pass:false},{id:'c',mode:'local',pass:false}]};
 const before=JSON.stringify(source),options=parseArgs(['--retry-failures=prior.json']);
 assert.deepEqual(selectJobs(corpus,options,source).map(j=>[j.sample.id,j.mode]),[['b','model'],['c','local']]);
 assert.equal(JSON.stringify(source),before);
 assert.throws(()=>selectJobs(corpus,options,{...source,status:'running'}),/complete/);
 assert.throws(()=>selectJobs(corpus,options,{status:'complete',results:[{id:'missing',mode:'model',pass:false}]}),/missing/);
});
test('fixture uses production record validation and revision conflicts',async()=>{
 const f=await createFixture({now:'2026-11-05T02:00:00.000Z',space:'life',seed:[record]});
 await assert.rejects(()=>f.port({op:'put',todo:{...record,sourceKind:'invented'},expectedRevision:1}),/invalid/);
 await assert.rejects(()=>f.port({op:'put',todo:{...record,revision:2},expectedRevision:0}),/conflict/);
 const changed=await f.todos.complete(record);
 assert.equal(changed.status,'completed');assert.equal(f.records.get('t').revision,2);
});
test('mocked model failure is counted as failure even if expected empty mutations match',async()=>{
 const sample={id:'mock',space:'life',text:'先别整理，记个信息',now:'2026-11-05T02:00:00.000Z',seed:[],expected:{created:0,changed:0}};
 const result=await runCase(sample,'model',{model:async()=>{throw Error('provider failed');}});
 assert.equal(result.pass,false);assert.ok(result.errors.some(x=>x.includes('model')));
});
test('mocked model executes actual service and preserves other-space sentinel',async()=>{
 const sample={id:'mock-create',space:'life',text:'帮我记一下交电费，先不设时间',now:'2026-11-05T02:00:00.000Z',seed:[],expected:{created:1,pending:1,timed:false}};
 const result=await runCase(sample,'model',{model:async input=>({content:JSON.stringify({version:1,items:[{kind:'task',intent:'explicit',title:'交电费',sourceQuote:input.text}],changes:[]})})});
 assert.deepEqual(result.errors,[]);assert.equal(result.pass,true);
});
test('CLI bounds and defaults are explicit',()=>{
 assert.deepEqual(parseArgs([]),{mode:'both',limit:Infinity,concurrency:4,resume:undefined,retryFailures:undefined,networkRetries:0});
 assert.equal(parseArgs(['--mode=local','--limit=5']).limit,5);
 assert.throws(()=>parseArgs(['--concurrency=0']));assert.throws(()=>parseArgs(['--mode=unknown']));
 assert.equal(parseArgs(['--network-retries=1']).networkRetries,1);assert.throws(()=>parseArgs(['--network-retries=-1']));
});
test('concurrent transport attribution records every retry attempt in its own case',async()=>{
 const counts={},provider=await createModelProvider({env:{LOOMA_REAL_API_KEY:'test-secret'},networkRetries:1,fetchImpl:async(url,options)=>{
  const text=JSON.parse(JSON.parse(options.body).messages[1].content).text;
  counts[text]=(counts[text]||0)+1;
  await new Promise(resolve=>setTimeout(resolve,text==='first'?8:1));
  if(counts[text]===1&&text==='first')return{ok:false,status:502};
  return{ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({version:1,items:[],changes:[]})}}]})};
 }});
 const first=[],second=[];
 try{
  const input=text=>({requestId:text,text,space:'life',now:'2026-11-05T02:00:00.000Z',context:{todos:[],turns:[]}});
  await Promise.all([provider.model(input('first'),first),provider.model(input('second'),second)]);
  assert.deepEqual(first.map(h=>h.status),[502,200]);assert.deepEqual(second.map(h=>h.status),[200]);
  assert.deepEqual(first.map(h=>h.attempt),[1,2]);assert.equal(provider.http.length,3);
 }finally{await provider.close();}
});
test('desktop transport records HTTP status without leaking response or credentials',async()=>{
 const provider=await createModelProvider({env:{LOOMA_REAL_API_KEY:'test-secret'},fetchImpl:async()=>({ok:false,status:429})});
 try{
  await assert.rejects(()=>provider.model({requestId:'status',text:'测试',space:'life',now:'2026-11-05T02:00:00.000Z',context:{todos:[],turns:[]}}));
  assert.equal(provider.http[0].status,429);assert.ok(provider.http[0].latencyMs>=0);
  assert.ok(!JSON.stringify(provider.http).includes('test-secret'));
 }finally{await provider.close();}
});

#!/usr/bin/env node
// Evaluates real persisted mutations. Never treats an assistant reply as an oracle.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const Module=require('node:module');
const crypto=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const root=path.resolve(__dirname,'..');
const clone=value=>JSON.parse(JSON.stringify(value));
const sameInstant=(a,b)=>typeof a==='string'&&typeof b==='string'&&Number.isFinite(Date.parse(a))&&Date.parse(a)===Date.parse(b);
let runtime;
function loadRuntime(){
 if(runtime)return runtime;
 const ts=require('typescript'),cache=new Map();
 function load(file){
  file=path.resolve(file);
  if(cache.has(file))return cache.get(file).exports;
  if(!/\.(ts|mjs)$/.test(file))return require(file);
  const mod=new Module(file,module);cache.set(file,mod);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));
  mod.require=function(spec){
   if(!spec.startsWith('.'))return Module.createRequire(file)(spec);
   const base=path.resolve(path.dirname(file),spec);
   const target=[base,`${base}.ts`,`${base}.js`,`${base}.cjs`,`${base}.mjs`,path.join(base,'index.ts')].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
   if(!target)throw Error(`Cannot resolve ${spec} from ${file}`);
   return load(target);
  };
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,allowJs:true}}).outputText;
  mod._compile(code,file);return mod.exports;
 }
 const agent=load(path.join(root,'src/services/personalAgent.ts'));
 const todos=load(path.join(root,'src/services/todos.ts'));
 const core=load(path.join(root,'shared/persistence-core.mjs'));
 return runtime={...agent,...todos,validateRecord:core.validateRecord};
}

async function createFixture(sample){
 const {createTodoService,validateRecord}=loadRuntime();
 const records=new Map(),now=Date.parse(sample.now);
 for(const value of sample.seed||[]){if(!validateRecord(value.space,'todo',value))throw Error('invalid seed record');records.set(value.id,clone(value));}
 const otherSpace=sample.space==='life'?'work':'life';
 const sentinel={id:'other-space-sentinel',space:otherSpace,title:'空间隔离哨兵',status:'pending',revision:1,createdAt:1,updatedAt:1};
 records.set(sentinel.id,clone(sentinel));
 async function port(command){
  if(command.op==='list')return {ok:true,todos:clone([...records.values()])};
  if(command.op==='put'){
   const todo=clone(command.todo),previous=records.get(todo.id);
   if(!validateRecord(todo.space,'todo',todo))throw Error('invalid persisted todo record');
   if((previous?.revision??null)!==command.expectedRevision)throw Error('revision conflict');
   if(previous&&(previous.space!==todo.space||todo.revision!==previous.revision+1))throw Error('invalid revision or space');
   records.set(todo.id,todo);return {ok:true,todo:clone(todo)};
  }
  if(command.op==='configure')return {ok:true,enabled:command.enabled};
  throw Error(`Unsupported fixture operation: ${command.op}`);
 }
 const todos=createTodoService(port,{now:()=>now,id:(()=>{let i=0;return()=>`fixture-${i++}`;})()});
 return {todos,records,port,sentinel,now};
}

function recordErrors(records,space){
 const errors=[];
 for(const record of records){
  if(space&&record.space!==space)errors.push(`space leakage: ${record.id}`);
  if(record.sourceKind!==undefined&&!['task','followup'].includes(record.sourceKind))errors.push(`sourceKind invalid: ${record.id}`);
  if(record.sourceTaskId!==undefined&&typeof record.sourceTaskId!=='string')errors.push(`sourceTaskId invalid: ${record.id}`);
 }
 return errors;
}
function checkSingle(sample,result,records){
 const e=sample.expected,errors=recordErrors(records,sample.space);
 const eq=(label,actual,expected)=>{if(expected!==undefined&&actual!==expected)errors.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);};
 eq('created',result.created.length,e.created??0);eq('changed',result.changed.length,e.changed??0);
 const created=result.created.map(t=>records.find(r=>r.id===t.id)).filter(Boolean);
 const changed=result.changed.map(t=>records.find(r=>r.id===t.id)).filter(Boolean);
 eq('persisted created',created.length,result.created.length);eq('persisted changed',changed.length,result.changed.length);
 for(const status of ['pending','suggested'])eq(status,created.filter(t=>t.status===status).length,e[status]);
 if(e.timed!==undefined)for(const t of created){
  eq(`dueAt present ${t.id}`,!!t.dueAt,e.timed);
  if(e.timed&&!sameInstant(t.dueAt,e.dueAt||'2026-11-06T07:00:00.000Z'))errors.push(`dueAt ${t.id}: wrong instant`);
 }
 for(const t of changed){if(e.status)eq('status',t.status,e.status);if(e.dueAt&&!sameInstant(t.dueAt,e.dueAt))errors.push(`dueAt: expected ${e.dueAt}, got ${t.dueAt}`);if(e.title)eq('title',t.title,e.title);}
 if(e.forbiddenTitle&&created.some(t=>t.title.includes(e.forbiddenTitle)))errors.push(`forbiddenTitle: ${e.forbiddenTitle}`);
 if(e.review)eq('business review',!!result.needsReview,true);
 return errors;
}
function checkSession(sample,records){
 const errors=recordErrors(records,sample.space),e=sample.expected;
 for(const [key,actual] of [['records',records.length],['completed',records.filter(t=>t.status==='completed').length],['cancelled',records.filter(t=>t.status==='cancelled').length]]){
  if(e[key]!==undefined&&e[key]!==actual)errors.push(`${key}: expected ${e[key]}, got ${actual}`);
 }
 if(e.finalRecords){
  const unmatched=[...records];
  for(const expected of e.finalRecords){
   const index=unmatched.findIndex(record=>Object.entries(expected).every(([key,value])=>key==='titleIncludes'?value.every(term=>record.title.includes(term)):value===null?record[key]===undefined:key==='dueAt'?sameInstant(record[key],value):record[key]===value));
   if(index<0)errors.push(`finalRecords missing match: ${JSON.stringify(expected)}`);else unmatched.splice(index,1);
  }
  if(unmatched.length)errors.push(`finalRecords unexpected: ${JSON.stringify(unmatched.map(t=>({title:t.title,status:t.status,dueAt:t.dueAt})))}`);
 }
 return errors;
}

async function createModelProvider({env=process.env,fetchImpl=globalThis.fetch,networkRetries=0}={}){
 if(!env.LOOMA_REAL_API_KEY)throw Error('LOOMA_REAL_API_KEY is required for model mode');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'looma-agent-eval-')),http=[],scope=new AsyncLocalStorage();
 const {createDesktopServices}=require(path.join(root,'electron/desktop-services.cjs'));
 const desktop=createDesktopServices({userDataPath:temp,safeStorage:{isEncryptionAvailable:()=>false},timeoutMs:Number(env.LOOMA_REAL_TIMEOUT_MS)||90000,fetchImpl:async(url,options)=>{
  for(let attempt=1;;attempt++){
   const start=performance.now(),entry={attempt,status:null,latencyMs:null};http.push(entry);scope.getStore()?.push(entry);
   let response,retry=false;
   try{response=await fetchImpl(url,options);entry.status=response.status;retry=[502,503,504].includes(response.status)&&attempt<=networkRetries;}
   catch(error){
    entry.networkFailure=true;entry.aborted=!!options.signal?.aborted;
    const name=error?.name,code=error?.cause?.code||error?.code;
    if(typeof name==='string'&&/^[A-Za-z]{1,40}$/.test(name))entry.errorName=name;
    if(typeof code==='string'&&/^[A-Z_0-9]{1,60}$/.test(code))entry.errorCode=code;
    retry=!entry.aborted&&attempt<=networkRetries;
    if(!retry)throw error;
   }finally{entry.latencyMs=Math.round(performance.now()-start);entry.retried=retry;}
   if(!retry)return response;
   if(response?.body?.cancel)try{await response.body.cancel();}catch{}
   await new Promise(resolve=>setTimeout(resolve,200*attempt));
  }
 }});
 try{
  const status=await desktop.saveModelConnection({apiBaseUrl:env.LOOMA_REAL_API_BASE||'https://nb.deepsb.com/v1',modelName:env.LOOMA_REAL_MODEL||'gpt-6.1-sol',enabled:true,apiKey:env.LOOMA_REAL_API_KEY});
  if(status.persistent||fs.readdirSync(temp).length)throw Error('Evaluation credentials must remain session-only');
 }catch(error){fs.rmdirSync(temp);throw error;}
 return {http,model:(input,sink)=>scope.run(sink,()=>desktop.captureAgentModel(input)),close:async()=>{await desktop.clearModelConnection();fs.rmdirSync(temp);}};
}

async function runCase(sample,mode,{model,http=[]}={}){
 const started=performance.now(),f=await createFixture(sample),errors=[],turnResults=[],modelEvents=[];
 const observedModel=model&&async function(input){
  const before=http.length,start=performance.now();
  // Assert the production agent itself only offers same-space context.
  if(input.context.todos.some(t=>t.space!==sample.space))throw Error('model context space leakage');
  const event={turn:turnResults.length,ok:false,http:[]};modelEvents.push(event);
  try{const result=await model(input);event.ok=true;return result;}
  catch(error){event.error='model provider/validation failure';throw error;}
  finally{event.latencyMs=Math.round(performance.now()-start);event.http=http.slice(before).map(clone);}
 };
 const {createPersonalAgent}=loadRuntime();
 const agent=createPersonalAgent({todos:f.todos,now:()=>f.now,model:mode==='model'?observedModel:undefined});
 let contextTaskId,history=[];
 const turns=sample.turns||[sample.text];
 for(const [index,text] of turns.entries()){
  const before=clone([...f.records.values()]);
  const result=await agent.capture({text,space:sample.space,sourceId:`${sample.id}-${index}`,turns:history,contextTaskId,useModel:mode==='model'});
  const after=clone([...f.records.values()]);
  if(JSON.stringify(f.records.get(f.sentinel.id))!==JSON.stringify(f.sentinel))errors.push(`turn ${index}: other-space sentinel changed`);
  for(const old of before.filter(t=>t.space!==sample.space))if(JSON.stringify(f.records.get(old.id))!==JSON.stringify(old))errors.push(`turn ${index}: cross-space write ${old.id}`);
  const created=after.filter(t=>t.space===sample.space&&!before.some(old=>old.id===t.id));
  const changed=after.filter(t=>t.space===sample.space&&before.some(old=>old.id===t.id&&old.revision!==t.revision));
  // Capture metadata must agree with actual writes; legacy supply-time may return an updated task in created.
  const reportedIds=new Set([...result.created,...result.changed].map(t=>t.id));
  for(const t of [...created,...changed])if(!reportedIds.has(t.id))errors.push(`turn ${index}: unreported write ${t.id}`);
  for(const t of [...result.created,...result.changed])if(!f.records.has(t.id))errors.push(`turn ${index}: reported nonpersisted write ${t.id}`);
  const observation={created,changed,needsReview:result.needsReview};
  turnResults.push({index,text,contextTaskId,created:created.map(t=>t.id),changed:changed.map(t=>t.id),modelUsed:result.modelUsed,warning:result.warning,needsReview:!!result.needsReview,records:after.filter(t=>t.space===sample.space)});
  if(!sample.turns)errors.push(...checkSingle(sample,observation,after.filter(t=>t.space===sample.space)));
  if(sample.expected.turnStates?.[index])errors.push(...checkSession({space:sample.space,expected:sample.expected.turnStates[index]},after.filter(t=>t.space===sample.space)).map(error=>`turn ${index}: ${error}`));
  const recent=[...changed,...created].at(-1);if(recent)contextTaskId=recent.id;
  history.push({role:'user',content:text,space:sample.space});
  if(result.message)history.push({role:'assistant',content:result.message,space:sample.space});
  if(mode==='model'&&result.modelUsed&&result.warning)errors.push(`turn ${index}: model failed or plan was rejected`);
 }
 const records=clone([...f.records.values()].filter(t=>t.space===sample.space));
 if(sample.turns)errors.push(...checkSession(sample,records));
 if(modelEvents.some(event=>!event.ok))errors.push('model call failed (fallback does not count as success)');
 for(const t of records)if(!loadRuntime().validateRecord(sample.space,'todo',t))errors.push(`invalid final record: ${t.id}`);
 return {id:sample.id,category:sample.category||'multi-turn',kind:sample.turns?'session':'single',mode,pass:errors.length===0,errors,latencyMs:Math.round(performance.now()-started),modelCalls:modelEvents.length,http:modelEvents.flatMap(x=>x.http),modelEvents,turns:turnResults,records};
}

function parseArgs(argv){
 const options={mode:'both',limit:Infinity,concurrency:4,resume:undefined,retryFailures:undefined,networkRetries:0};
 for(const arg of argv){const match=/^--(mode|limit|concurrency|resume|retry-failures|network-retries)=(.+)$/.exec(arg);if(!match)throw Error(`Unknown argument: ${arg}`);const [,key,value]=match;options[{'retry-failures':'retryFailures','network-retries':'networkRetries'}[key]||key]=['limit','concurrency','network-retries'].includes(key)?Number(value):value;}
 if(!['both','local','model'].includes(options.mode)||![options.limit,options.concurrency].every(x=>x===Infinity||Number.isSafeInteger(x)&&x>0)||!Number.isFinite(options.concurrency))throw Error('Invalid mode, limit, or concurrency');
 if(!Number.isSafeInteger(options.networkRetries)||options.networkRetries<0||options.networkRetries>3)throw Error('network-retries must be 0..3');
 return options;
}
function selectJobs(corpus,options,source){
 const samples=[...corpus.singles,...corpus.sessions],modes=options.mode==='both'?['local','model']:[options.mode];
 if(!source)return modes.flatMap(mode=>[...corpus.singles.slice(0,options.limit),...corpus.sessions.slice(0,options.limit)].map(sample=>({sample,mode})));
 if(source.status!=='complete'||!Array.isArray(source.results))throw Error('Retry source must be a complete evaluation report');
 const seen=new Set(),counts={};
 return source.results.filter(r=>r.pass===false&&modes.includes(r.mode)).flatMap(result=>{
  const sample=samples.find(s=>s.id===result.id);if(!sample)throw Error(`Retry case missing from current corpus: ${result.id}`);
  const key=`${result.mode}/${result.id}`,group=`${result.mode}/${sample.turns?'session':'single'}`;
  if(seen.has(key)||(counts[group]||0)>=options.limit)return[];
  seen.add(key);counts[group]=(counts[group]||0)+1;return[{sample,mode:result.mode}];
 });
}
function atomicWrite(file,text){
 const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,text);
 // Windows scanners may briefly hold a report open. Retain atomic replacement,
 // retry the same rename, and never delete a valid previous checkpoint.
 for(let attempt=0;;attempt++)try{fs.renameSync(temp,file);return;}
 catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt===6)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10*2**attempt);}
}
function summarize(results){
 const summary={cases:results.length,passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,modelCalls:results.reduce((n,r)=>n+r.modelCalls,0),httpCalls:results.reduce((n,r)=>n+r.http.length,0),httpStatuses:{},groups:{}};
 for(const r of results){for(const h of r.http){const key=h.status??'network-failure';summary.httpStatuses[key]=(summary.httpStatuses[key]||0)+1;}const key=`${r.mode}/${r.kind}`;const g=summary.groups[key]??={total:0,passed:0,failed:0};g.total++;g[r.pass?'passed':'failed']++;}
 return summary;
}
function markdown(report){
 const s=report.summary;
 const provenance=report.retryOrigin?`\n\nThis is a bounded failure regression, NOT a first-attempt full evaluation. Original report: ${report.retryOrigin.path}; SHA256: ${report.retryOrigin.reportHash}. The original report is preserved; corpus/source changes are recorded in JSON.`:'';
 return `# Personal agent evaluation\n\nStarted: ${report.startedAt}\n\nStatus: ${report.status}\n\nModel: ${report.modelName}\n\nCorpus: ${report.corpusHash}${provenance}\n\nFixed time: 2026-11-05T02:00:00.000Z (Asia/Shanghai)\n\n${s.cases} cases; ${s.passed} passed; ${s.failed} failed; ${s.modelCalls} model calls; ${s.httpCalls} HTTP calls.\n\nLocal fast-path is not forced to call the model. Transport/model rejection fails the case even if fallback mutations match. Limit applies separately to singles and sessions. Network retries per call: ${report.options.networkRetries||0}; all HTTP attempts, including recovered failures, are counted above. Oracle compares exact timestamp instants, not ISO timezone spelling.\n\n| Group | Total | Passed | Failed |\n|---|---:|---:|---:|\n${Object.entries(s.groups).map(([k,g])=>`| ${k} | ${g.total} | ${g.passed} | ${g.failed} |`).join('\n')}\n\nHTTP statuses: ${JSON.stringify(s.httpStatuses)}\n\n## Failed cases (all)\n\n${report.results.filter(r=>!r.pass).map(r=>`- **${r.mode}/${r.id}**: ${r.errors.join('; ')}`).join('\n')||'None'}\n\nJSON contains exact per-turn persisted records, provenance fields, HTTP status and latency. Model response bodies and credentials are intentionally omitted.\n`;
}
async function main(argv=process.argv.slice(2)){
 const options=parseArgs(argv),corpus=require(path.join(root,'tests/agent-language-corpus.cjs'));
 const corpusHash=crypto.createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
 const implementationHash=crypto.createHash('sha256');
 for(const file of ['src/services/personalAgent.ts','src/services/todos.ts','shared/persistence-core.mjs','shared/agent-model.cjs','electron/desktop-services.cjs'])implementationHash.update(fs.readFileSync(path.join(root,file)));
 const sourceHash=implementationHash.digest('hex');
 const directory=path.join(root,'output/agent-evaluation');fs.mkdirSync(directory,{recursive:true});
 const id=new Date().toISOString().replace(/[:.]/g,'-');
 const jsonPath=options.resume?path.resolve(options.resume):path.join(directory,`${id}-${options.retryFailures?'retry-':''}${options.mode}.json`),mdPath=jsonPath.replace(/\.json$/,'.md');
 let report={startedAt:new Date().toISOString(),status:'running',modelName:process.env.LOOMA_REAL_MODEL||'gpt-6.1-sol',corpusHash,sourceHash,options:{...options,limit:Number.isFinite(options.limit)?options.limit:null},results:[]};
 let retrySource;
 if(options.retryFailures){
  const sourcePath=path.resolve(options.retryFailures);
  if(sourcePath===jsonPath)throw Error('Retry report must not overwrite its source');
  const sourceBytes=fs.readFileSync(sourcePath);retrySource=JSON.parse(sourceBytes);
  report.retryOrigin={path:sourcePath,reportHash:crypto.createHash('sha256').update(sourceBytes).digest('hex'),corpusHash:retrySource.corpusHash,sourceHash:retrySource.sourceHash,summary:retrySource.summary};
 }
 if(options.resume){const previous=JSON.parse(fs.readFileSync(jsonPath,'utf8'));if(previous.corpusHash!==corpusHash||previous.sourceHash!==sourceHash||previous.modelName!==report.modelName||previous.options.mode!==options.mode||previous.options.limit!==report.options.limit)throw Error('Resume corpus/source/options mismatch');report=previous;report.status='running';}
 const jobs=selectJobs(corpus,options,retrySource).filter(job=>!report.results.some(r=>r.id===job.sample.id&&r.mode===job.mode));
 const checkpoint=()=>{report.summary=summarize(report.results);atomicWrite(jsonPath,JSON.stringify(report,null,2));atomicWrite(mdPath,markdown(report));};
 checkpoint();
 let cursor=0,provider;
 try{
  if(jobs.some(j=>j.mode==='model'))provider=await createModelProvider({networkRetries:options.networkRetries});
  await Promise.all(Array.from({length:Math.min(options.concurrency,jobs.length)},async()=>{
   while(cursor<jobs.length){const {sample,mode}=jobs[cursor++];let result;
    // HTTP arrays are per case, so concurrent requests cannot be attributed to a neighboring case.
    const perCaseHttp=[];
    const model=provider&&(input=>provider.model(input,perCaseHttp));
    try{result=await runCase(sample,mode,{model,http:perCaseHttp});}
    catch(error){result={id:sample.id,category:sample.category||'multi-turn',kind:sample.turns?'session':'single',mode,pass:false,errors:['evaluation exception (inspect harness tests)'],modelCalls:perCaseHttp.length,http:clone(perCaseHttp)};}
    report.results.push(result);checkpoint();
    console.log(`[${report.results.length}] ${mode}/${sample.id}: ${result.pass?'PASS':'FAIL'} (${result.modelCalls} model calls)`);
   }
  }));
  report.status='complete';report.completedAt=new Date().toISOString();checkpoint();
  console.log(JSON.stringify({report:jsonPath,markdown:mdPath,...report.summary},null,2));
  return report;
 }catch(error){report.status='interrupted';checkpoint();throw error;}
 finally{if(provider)await provider.close();}
}
module.exports={loadRuntime,createFixture,checkSingle,checkSession,createModelProvider,runCase,parseArgs,selectJobs,summarize,main};
if(require.main===module)main().then(report=>{process.exitCode=report.summary.failed?1:0;}).catch(()=>{console.error('Evaluation interrupted. Check environment/options and resume from the JSON checkpoint. Credentials and provider response bodies are not logged.');process.exitCode=2;});

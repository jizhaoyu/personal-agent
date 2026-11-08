const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDesktopServices } = require('../electron/desktop-services.cjs');
const input = () => ({ requestId: 'capture-1', text: '记住买牛奶', space: 'life', now: '2026-11-05T12:00:00+08:00', context: {
  todos: [{id:'life-1',space:'life',title:'牛奶',status:'active',revision:2,sourceText:'SECRET',notes:'SECRET'},
    {id:'work-1',space:'work',title:'PRIVATE WORK',status:'active',revision:1}],
  turns: [{role:'user',content:'买牛奶',credentials:'SECRET'}], contextTaskId:'work-1', notes:'SECRET'
}});
async function setup(t, fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-agent-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const svc = createDesktopServices({userDataPath:dir,fetchImpl, safeStorage:{isEncryptionAvailable:()=>false}});
  await svc.saveModelConnection({apiBaseUrl:'http://localhost:11434/v1',modelName:'test',enabled:true});
  return svc;
}
test('agent capture sends bounded same-space whitelist and structured candidates', async t => {
  let body;
  const result = {version:1,items:[{kind:'task',title:'买牛奶',intent:'explicit',sourceQuote:'记住买牛奶'}],changes:[]};
  const svc = await setup(t, async (_, options) => {body=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(result)}}]})};});
  assert.equal(typeof svc.captureAgentModel, 'function');
  assert.deepEqual(JSON.parse((await svc.captureAgentModel(input())).content),result);
  assert.doesNotMatch(JSON.stringify(body), /SECRET|PRIVATE WORK|work-1|sourceText|credentials/);
  const sent = JSON.parse(body.messages[1].content);
  assert.deepEqual(sent.context.todos,[{id:'life-1',space:'life',title:'牛奶',status:'active',revision:2}]);
  assert.match(body.messages[0].content,/否定/);
  assert.match(body.messages[0].content,/预算/);
  const many = input(); many.context.todos=Array.from({length:100},(_,i)=>({id:`a${i}`,space:'life',title:'x',status:'active',revision:1}));
  many.context.turns=Array.from({length:10},()=>({role:'user',content:'x'}));
  await svc.captureAgentModel(many);
  const bounded=JSON.parse(body.messages[1].content);
  assert.equal(bounded.context.todos.length,80);assert.equal(bounded.context.turns.length,6);
});
test('agent capture rejects invalid context, output and non-context entity writes', async t => {
  let output = {version:1,items:[],changes:[{todoId:'work-1',expectedRevision:1,action:'complete',sourceQuote:'完成'}]};
  let calls=0;
  const svc=await setup(t,async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output)}}]})};});
  assert.equal(typeof svc.captureAgentModel,'function');
  const changeInput=()=>({...input(),text:'完成牛奶'});
  await assert.rejects(()=>svc.captureAgentModel(changeInput()),/模型|上下文/);
  output={version:1,items:[],changes:[{todoId:'life-1',expectedRevision:1,action:'complete',sourceQuote:'完成'}]};
  await assert.rejects(()=>svc.captureAgentModel(changeInput()),/模型|版本/);
  output={version:1,items:[],changes:[],sql:'DELETE'};
  await assert.rejects(()=>svc.captureAgentModel(input()),/模型/);
  const invalid=input();invalid.text='x'.repeat(20001);
  await assert.rejects(()=>svc.captureAgentModel(invalid),/请求/);
  assert.equal(calls,3);
});
test('agent capture accepts current revision changes and rejects invented quotes and impossible times', async t => {
  let output={version:1,items:[],changes:[{todoId:'life-1',expectedRevision:2,action:'rename',sourceQuote:'记住买牛奶',title:'牛奶'}]};
  const svc=await setup(t,async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(output)}}]})}));
  assert.deepEqual(JSON.parse((await svc.captureAgentModel(input())).content),output);
  output.changes[0].sourceQuote='不存在的原文';
  await assert.rejects(()=>svc.captureAgentModel(input()),/模型/);
  output={version:1,items:[{kind:'task',title:'牛奶',intent:'explicit',sourceQuote:'记住买牛奶',dueAt:'2026-02-30T10:00:00+08:00'}],changes:[]};
  await assert.rejects(()=>svc.captureAgentModel(input()),/模型/);
  delete output.items[0].dueAt;
  output.items[0].dueDate='2026-11-06';
  assert.equal(JSON.parse((await svc.captureAgentModel(input())).content).items[0].dueDate,'2026-11-06');
});
test('agent capture reuses cancellation and disabled connection gates', async t => {
  let start;
  const started=new Promise(resolve=>{start=resolve;});
  const svc=await setup(t,async(_,options)=>{start();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('abort'))));});
  assert.equal(typeof svc.captureAgentModel,'function');
  const pending=svc.captureAgentModel(input());await started;
  await assert.rejects(()=>svc.captureAgentModel(input()),/处理中/);
  await svc.cancelModel('capture-1');await assert.rejects(()=>pending,/取消/);
  await svc.clearModelConnection();await assert.rejects(()=>svc.captureAgentModel(input()),/启用/);
});

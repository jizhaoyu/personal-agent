import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTodoText, createTodoService } from '../src/services/todos';
import { routeLifeInput } from '../src/services/lifeRouting';
const now = Date.parse('2026-11-04T04:00:00Z');
const todo = (id: string, title: string, space: 'life'|'work' = 'life'): any => ({ id, title, space, status: 'pending', revision: 1, createdAt: now, updatedAt: now, dueAt: '2026-11-05T07:00:00Z' });
test('life routing keeps activity and commentary out of todos and preserves independent action',()=>{
  for(const phrase of ['今天跑步了','今天的云真好看','昨天的报销还没到账']){
    assert.equal(analyzeTodoText(phrase,{now,space:'life',todos:[]}).kind,'none');
  }
  const raw='奖金到账8,500元，明天下午三点提醒我拿快递';
  const parts=routeLifeInput(raw);
  assert.deepEqual(parts.map(x=>x.route),['fact','action']);
  assert.ok(parts.every(x=>x.text===raw.slice(x.start,x.end)));
  assert.deepEqual(routeLifeInput('有人说“花了99元，先记一笔”；午饭实付18元').map(x=>x.route),['original','fact']);
  assert.ok(routeLifeInput('取消那个提醒，我不记得是哪一条').every(x=>x.route==='original'));
  assert.equal(analyzeTodoText('取消那个提醒',{now,space:'life',todos:[todo('x','交电费')]}).kind,'none');
});
test('explicit reminders create only with a complete future date and clock', () => {
  const result = analyzeTodoText('明天下午3点提醒我交电费', { now, space: 'life', todos: [] });
  assert.equal(result.kind, 'create'); assert.equal(result.title, '交电费'); assert.equal(result.dueAt, '2026-11-05T07:00:00.000Z');
  const missing = analyzeTodoText('提醒我周五发报价', { now, space: 'work', todos: [] });
  assert.equal(missing.kind, 'create'); assert.equal(missing.needsTime, true); assert.equal(missing.dueAt, undefined); assert.equal(missing.dueDate, '2026-11-06');
});
test('normal plans are suggestions and Chinese time is supported without guessing nine oclock', () => {
  const plan = analyzeTodoText('我明天下午三点把报价发给陈总', { now, space: 'work', todos: [] });
  assert.equal(plan.kind, 'suggest'); assert.ok(plan.title?.includes('报价')); assert.equal(plan.dueAt, '2026-11-05T07:00:00.000Z');
  assert.equal(analyzeTodoText('我明天可能去交电费', { now, space: 'life', todos: [] }).kind, 'suggest');
  const later = analyzeTodoText('15分钟后提醒我喝水', { now, space: 'life', todos: [] }); assert.equal(later.dueAt, '2026-11-04T04:15:00.000Z');
});
test('negation, hypothetical completion and quoted examples never complete a task', () => {
  for (const text of ['电费还没交', '明天完成交电费', '准备完成交电费', '如果完成交电费就好了', '只是举例：电费已经交了', '电费已经交了吗？', '我以为电费已经交了', '电费应该已经交了', '电费还没完成了吧', '电费不交了', '报价不发了']) {
    assert.notEqual(analyzeTodoText(text, { now, space: 'life', todos: [todo('a','交电费')] }).kind, 'complete', text);
  }
  for(const text of ['电费不用交了','电费不需要交了','电费不用再交了','报价不用发了','电费是不是交了','确认一下电费是否交了'])assert.notEqual(analyzeTodoText(text,{now,space:'life',todos:[todo('a','交电费'),todo('b','发报价')]}).kind,'complete',text);
});
test('completion matches one current-space item, otherwise asks instead of guessing', () => {
  const tasks = [todo('a','交电费'),todo('b','陈总发报价','work')];
  assert.equal(analyzeTodoText('电费已经交了', { now, space: 'life', todos: tasks }).todoId, 'a');
  assert.notEqual(analyzeTodoText('陈总报价已经发了', { now, space: 'life', todos: tasks }).kind, 'complete');
  const ambiguous = [todo('a','陈总发报价'),todo('b','李总发报价')];
  assert.equal(analyzeTodoText('报价已经发了', { now, space: 'life', todos: ambiguous }).kind, 'clarify');
  assert.equal(analyzeTodoText('完成了', { now, space: 'life', todos: ambiguous, contextTaskId: 'b' }).todoId, 'b');
});
test('cancellation differs from completion and a past time is not silently moved to tomorrow', () => {
  assert.equal(analyzeTodoText('取消交电费的提醒', { now, space: 'life', todos: [todo('a','交电费')] }).kind, 'cancel');
  const past = analyzeTodoText('今天上午9点提醒我交电费', { now, space: 'life', todos: [] }); assert.equal(past.needsTime, true); assert.equal(past.dueAt, undefined);
  const noDate = analyzeTodoText('下午3点提醒我交电费', { now, space: 'life', todos: [] });assert.equal(noDate.needsTime,true);assert.equal(noDate.dueAt,undefined);
});
function fixture() {
  const records = new Map<string, any>(); let enabled=false;
  const port = async (c: any) => {
    if(c.op==='list')return {ok:true,todos:[...records.values()].filter(t=>!c.space||t.space===c.space)};
    if(c.op==='configure'){enabled=c.enabled;return{ok:true};}
    if(c.op==='capabilities'||c.op==='requestPermissions')return {ok:true,enabled,background:false,notifications:'unsupported',exactAlarms:'unsupported'};
    if(c.op==='put'){const before=records.get(c.todo.id);if((before?.revision??null)!==c.expectedRevision)return{ok:false,error:'版本冲突'};records.set(c.todo.id,structuredClone(c.todo));return{ok:true,todo:c.todo};}
    if(c.op==='replaceAll'){records.clear();c.todos.forEach(t=>records.set(t.id,t));return{ok:true};}
    throw Error(c.op);
  };
  return { records, port, service: createTodoService(port, {now:()=>now,id:()=>`t${records.size+1}`}) };
}
test('only explicit, fully timed reminders become pending; completion is silent and retained', async () => {
  const {service,records}=fixture();
  let result=await service.handleText('明天下午3点提醒我交电费','life'); assert.equal(result.created?.status,'pending');
  assert.equal((await service.handleText('我明天发报价','work')).created?.status,'suggested');
  result=await service.handleText('电费已经交了','life');assert.equal(result.silent,true);assert.equal((await service.list('life')).length,0);
  assert.equal([...records.values()].find(t=>t.space==='life').status,'completed');assert.ok([...records.values()].find(t=>t.space==='life').completedAt);
});
test('missing clock can be supplied in a followup without making a second task', async () => {
  const {service,records}=fixture(); const result=await service.handleText('提醒我周五发报价','work');assert.ok(result.needsTime);
  assert.equal(result.created?.status,'pending');assert.equal(result.message,'已记下，尚未安排准确提醒。时间可以以后再补。');
  await service.handleText('下午三点','work');assert.equal(records.size,1);assert.equal((await service.list('work'))[0].dueAt,'2026-11-06T07:00:00.000Z');
});

test('casual explicit capture saves without a date, can be silently completed, and never enables alarms',async()=>{
  const f=fixture();let enables=0;
  const service=createTodoService(async c=>{if(c.op==='configure')enables++;return f.port(c);},{now:()=>now});
  const result=await service.handleText('找时间把电费交了，先记着','life');
  assert.equal(result.created?.status,'pending');assert.equal(result.created?.dueAt,undefined);assert.equal(enables,0);
  assert.equal((await service.handleText('电费已经交了','life')).silent,true);
});

test('confirming an undated suggestion never requires or enables a reminder',async()=>{
  const {service}=fixture();const suggestion=await service.create({space:'work',title:'跟进合同',status:'suggested',needsTime:true});
  const confirmed=await service.approve(suggestion);assert.equal(confirmed.status,'pending');assert.equal(confirmed.dueAt,undefined);assert.equal((await service.capabilities()).enabled,false);
});
test('snooze increments revision and no ambiguous completion modifies records', async () => {
  const {service,records}=fixture();const a=await service.create({space:'life',title:'陈总发报价',status:'pending'});await service.create({space:'life',title:'李总发报价',status:'pending'});
  const result=await service.handleText('报价完成了','life');assert.equal(result.needsChoice?.length,2);assert.ok([...records.values()].every(t=>t.status==='pending'));
  const snoozed=await service.snooze(a);assert.equal(snoozed.dueAt,new Date(now+15*60000).toISOString());assert.equal(snoozed.revision,2);
});

test('legacy projection is paged, idempotent, preserves native completion and handles reopen or deletion',async()=>{
  const {records,port}=fixture();let source:any={id:'a',title:'发报价',done:false,dueAt:'2026-11-05T07:00:00Z'};let calls=0;
  const repo:any={async query(_space:string,kind:string){calls++;return{items:kind==='task'&&source?[source]:[]};},async get(){return source;},async setItemState(_kind:string,_item:any,done:boolean){source={...source,done};return{outcome:'committed'};}};
  const service=createTodoService(port,{repository:repo,now:()=>now});
  await Promise.all([service.syncLegacy(),service.syncLegacy()]);assert.equal(calls,2);assert.equal(records.size,1);
  let task=(await service.list('work'))[0];await service.complete(task);await service.syncLegacy();assert.equal((await service.list('work')).length,0);
  source.done=false;await service.syncLegacy();task=(await service.list('work'))[0];assert.equal(task.status,'pending');
  source=null;await service.syncLegacy();assert.equal((await service.list('work')).length,0);assert.equal((await service.list('work',true))[0].status,'cancelled');
  source={id:'a',title:'发报价',done:false};await service.syncLegacy();assert.equal((await service.list('work'))[0].needsTime,true);assert.equal((await service.list('work'))[0].status,'suggested');
});

test('failed scheduling enable never leaves a falsely pending task; retry can finish',async()=>{
  const f=fixture();let failing=true;
  const service=createTodoService(async c=>c.op==='configure'&&failing?{ok:false,error:'enable failed'}:f.port(c),{now:()=>now,id:()=>`t${f.records.size+1}`});
  await assert.rejects(service.handleText('明天下午3点提醒我交电费','life'),/enable failed/);assert.equal(f.records.size,0);
  failing=false;const result=await service.handleText('明天下午3点提醒我交电费','life');assert.equal(result.created?.status,'pending');
  const suggested=await service.create({space:'work',title:'发报价',status:'suggested',dueAt:'2026-11-05T07:00:00Z'});failing=true;
  await assert.rejects(service.approve(suggested),/enable failed/);assert.equal((await service.list('work'))[0].status,'suggested');
});

test('complex project communication stays in the existing review flow rather than a todo suggestion',()=>{
  const result=analyzeTodoText('陈总的商城改版项目预算3万元，需求已确认，周五下午三点发报价',{now,space:'work',todos:[]});assert.equal(result.kind,'none');
});

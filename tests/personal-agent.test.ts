import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAgent, parseAgentPlan } from '../src/services/personalAgent';
import { createTodoService } from '../src/services/todos';
import { StateEngine } from '../src/services/stateEngine';
import type { TodoRecord, WorkPartition } from '../src/types';

const now = Date.parse('2026-11-05T02:00:00Z');
function fixture(initial:TodoRecord[] = []) {
  const records = new Map(initial.map(t => [t.id,t]));
  const todos = createTodoService(async c => {
    if(c.op === 'list') return {todos:[...records.values()]};
    if(c.op === 'put') { const previous=records.get(c.todo.id); if((previous?.revision??null)!==c.expectedRevision) throw Error('conflict'); records.set(c.todo.id,c.todo); return {todo:c.todo}; }
    return {ok:true};
  },{now:()=>now});
  return {todos,records};
}
const todo = (id='one',space:'life'|'work'='life'):TodoRecord => ({id,space,title:'交电费',status:'pending',revision:1,createdAt:now,updatedAt:now,needsTime:true});
const task = (title:string,sourceQuote=title) => ({kind:'task',title,intent:'explicit',sourceQuote});
const plan = (items:any[]=[],changes:any[]=[]) => JSON.stringify({version:1,items,changes});

test('a clock-only follow-up can update the one task written on the previous turn',async()=>{
  const f=fixture();
  const agent=createPersonalAgent({...f,now:()=>now});
  const first=await agent.capture({text:'明天下午三点提醒我交电费',space:'life',sourceId:'focus-create'});
  assert.equal(first.created.length,1);
  const second=await agent.capture({text:'不是明天，是后天下午四点',space:'life',sourceId:'focus-correct'});
  assert.equal(second.changed[0]?.id,first.created[0].id);
  assert.equal(second.changed[0]?.dueAt,'2026-11-07T08:00:00.000Z');
});

test('a multi-create turn and a stale focus cannot authorize a title-free follow-up',async()=>{
  const f=fixture();
  const agent=createPersonalAgent({...f,now:()=>now,model:async input=>({
    content:plan(input.requestId==='multi-focus'?[task('买牛奶'),task('买鸡蛋')]:[]),
  })});
  const multi=await agent.capture({text:'帮我记一下买牛奶，买鸡蛋',space:'life',sourceId:'multi-focus'});
  assert.equal(multi.created.length,2);
  const before=structuredClone([...f.records.values()]);
  await agent.capture({text:'完成了',space:'life',sourceId:'ambiguous-complete',contextTaskId:multi.created[1].id});
  assert.deepEqual([...f.records.values()],before);
  await agent.capture({text:'就明天下午三点吧',space:'life',sourceId:'ambiguous-focus',contextTaskId:multi.created[1].id});
  assert.deepEqual([...f.records.values()],before);
  const one=await agent.capture({text:'明天下午三点提醒我交电费',space:'life',sourceId:'stale-create'});
  assert.equal(one.created.length,1);
  await f.todos.update(one.created[0],{title:'交水费'});
  const revised=structuredClone([...f.records.values()]);
  await agent.capture({text:'标题改成核对账单',space:'life',sourceId:'stale-rename',contextTaskId:one.created[0].id});
  assert.deepEqual([...f.records.values()],revised);
});

test('payment follow-up recognizes rent but does not choose between two open payments',async()=>{
  const rent={...todo('rent'),title:'交房租'};
  const contract={...todo('contract'),title:'给客户发合同'};
  for(const [records,expected] of [
    [[rent,contract],['rent']],
    [[rent,contract,todo('fee')],[]],
  ] as const){
    const f=fixture([...records]);
    const agent=createPersonalAgent({...f,now:()=>now});
    const result=await agent.capture({text:'交费那个已经处理好了',space:'life',sourceId:'rent-followup'});
    assert.deepEqual(result.changed.map(t=>t.id),expected);
    assert.equal(f.records.get('contract')?.status,'pending');
  }
});

test('local shortcuts do not act on another person completing, a negated cancellation, or a mismatched old clock',async()=>{
  const rows=[
    {title:'发周报',text:'我同事把周报刚发出去了，发周报这条给我划了。'},
    {title:'大厅接人',text:'来访的人不来了，大厅接人的提醒别关掉。'},
    {title:'去办卡',text:'去办卡那条别删，把七点响改成六点二十。',dueAt:'2026-11-05T10:00:00Z'},
  ];
  for(const [i,row] of rows.entries()){
    const initial={...todo(),title:row.title,dueAt:row.dueAt};
    const f=fixture([initial]);
    const agent=createPersonalAgent({todos:f.todos,now:()=>now});
    await agent.capture({text:row.text,space:'life',sourceId:`protected-shortcut-${i}`});
    assert.deepEqual([...f.records.values()],[initial]);
  }
});

test('named work commands change exactly one existing task, preserving other fields',async()=>{
  const title='对报价附件（测试批）';
  const initial={...todo('target','work'),title,needsTime:false,dueAt:'2026-11-06T07:00:00.000Z',dueDate:'2026-11-06'};
  const life={...initial,id:'life',space:'life' as const};
  const neighbor={...initial,id:'neighbor',title:'对报价附件'};
  const rows=[
    {text:title+'完成了',status:'completed'},
    {text:'取消'+title+'的提醒',status:'cancelled'},
    {text:title+'那条提醒改到后天下午四点',dueAt:'2026-11-07T08:00:00.000Z',dueDate:'2026-11-07'},
    {text:title+'那条标题改成重新'+title,title:'重新'+title},
    {text:title+'那条标题改成复核对报价附件',title:'复核对报价附件'},
  ];
  for(const [i,{text,...change}] of rows.entries()){
    const f=fixture([initial,life,neighbor]);
    const result=await createPersonalAgent({...f,now:()=>now}).capture({text,space:'work',sourceId:'work-mutation-'+i});
    assert.equal(result.handled,true,text);
    assert.deepEqual(result.created,[]);
    assert.deepEqual(result.changed.map(t=>t.id),['target'],text);
    const actual=f.records.get('target')!;
    for(const k of ['title','status','dueAt','dueDate'] as const)assert.equal(actual[k],change[k]??initial[k],text);
    assert.deepEqual(f.records.get('life'),life);
    assert.deepEqual(f.records.get('neighbor'),neighbor);
  }
});

test('named work commands never guess missing, duplicate, negated or invalid targets',async()=>{
  const initial={...todo('target','work'),title:'对报价附件（测试批）'};
  const duplicate={...initial,id:'duplicate',title:'对报价附件(测试批)'};
  const life={...initial,id:'life',space:'life' as const};
  for(const [i,[text,records]] of ([
    ['取消对报价附件（测试批）的提醒',[initial,duplicate]],
    ['取消对报价附件（测试批）的提醒',[life]],
    ['取消对报价附件（已关闭）的提醒',[{...initial,title:'对报价附件（已关闭）',status:'completed'}]],
    ['别取消对报价附件（测试批）的提醒',[initial]],
    ['客户说对报价附件（测试批）完成了',[initial]],
    ['对报价附件（测试批）还没完成了',[initial]],
    ['对报价附件（测试批）完成了吗？',[initial]],
    ['对报价附件（测试批）那条提醒改到后天',[initial]],
    ['对报价附件（测试批）那条提醒改到后天下午四点，另外取消一条',[initial]],
  ] satisfies [string,TodoRecord[]][]).entries()){
    const f=fixture(records);
    const result=await createPersonalAgent({...f,now:()=>now}).capture({text,space:'work',sourceId:'unsafe-mutation-'+i});
    assert.deepEqual(result.changed,[],text);
    assert.deepEqual(result.created,[],text);
    assert.deepEqual([...f.records.values()],records,text);
  }
});

test('capture preamble and no-time qualifier do not count as separate actions',async()=>{
  const f=fixture();const agent=createPersonalAgent({...f,now:()=>now,model:async()=>({content:plan([task('交水费','找时间交水费，现在没空弄')])})});
  const r=await agent.capture({text:'帮我记一下，找时间交水费，现在没空弄',space:'work',sourceId:'real-untimed'});
  assert.equal(r.created.length,1);assert.equal(r.warning,undefined);assert.equal(r.created[0].dueAt,undefined);
});

test('negative status is not a new task; a no-time qualifier is not a missing action',async()=>{
  const f=fixture([todo()]);let calls=0;
  const agent=createPersonalAgent({...f,now:()=>now,model:async()=>{calls++;return {content:plan([task('预约牙医'),task('打印材料')])};}});
  const negative=await agent.capture({text:'电费还没交，别当成已经完成',space:'life',sourceId:'negative-status'});
  assert.equal(calls,0);assert.equal(negative.created.length,0);assert.equal(f.records.get('one')?.status,'pending');
  const r=await agent.capture({text:'帮我记一下预约牙医，打印材料，都不设时间',space:'life',sourceId:'optional-time'});
  assert.equal(r.created.length,2);assert.equal(r.warning,undefined);
});

test('multi-item capture creates separate tasks, keeps notes raw, and is idempotent',async()=>{
  const f=fixture(); let calls=0;
  const agent=createPersonalAgent({...f,now:()=>now,model:async()=>{calls++;return {content:plan([task('买牛奶'),task('发合同'),{kind:'note',title:'预算三万',intent:'suggested',sourceQuote:'预算三万'}])};}});
  const input={text:'记一下买牛奶，发合同，预算三万',space:'life' as const,sourceId:'msg-1'};
  const r=await agent.capture(input);
  assert.equal(r.created.length,2); assert.equal(f.records.size,2);
  assert.ok(r.created.every(t=>t.status==='pending'&&t.needsTime));
  await agent.capture(input); assert.equal(f.records.size,2); assert.equal(calls,1);
});

test('strict validation rejects invented quotes, wrong spaces, stale revisions and unknown fields',()=>{
  const context={text:'电费交了',space:'life' as const,todos:[todo(),todo('work','work')],now};
  for(const change of [
    {todoId:'one',expectedRevision:1,action:'complete',sourceQuote:'已交电费'},
    {todoId:'work',expectedRevision:1,action:'complete',sourceQuote:'电费交了'},
    {todoId:'one',expectedRevision:2,action:'complete',sourceQuote:'电费交了'},
    {todoId:'one',expectedRevision:1,action:'complete',sourceQuote:'电费交了',budget:30000},
  ]) assert.throws(()=>parseAgentPlan(plan([], [change]),context));
});

test('negative, hypothetical and question completion plans never execute',async()=>{
  for(const text of ['电费是不是已经交了','我以为电费交了，实际还没','如果电费交了就好了','电费不用交了']) {
    const f=fixture([todo()]);
    const agent=createPersonalAgent({...f,now:()=>now,model:async()=>({content:plan([],[{todoId:'one',expectedRevision:1,action:'complete',sourceQuote:text}])})});
    await agent.capture({text,space:'life',sourceId:text,useModel:true});
    assert.equal(f.records.get('one')!.status,'pending',text);
  }
});

test('restored identity and concurrent state changes invalidate delayed model results',async()=>{
  for(const restore of [true,false]) {
    const f=fixture([todo()]);let identity='1';let release!:(v:any)=>void;
    const agent=createPersonalAgent({...f,readIdentity:()=>identity,now:()=>now,model:()=>new Promise(r=>release=r)});
    const pending=agent.capture({text:'那个搞定了',space:'life',sourceId:'late',useModel:true});
    while(!release) await new Promise(r=>setTimeout(r,0));
    if(restore) identity='2'; else f.records.set('one',{...todo(),revision:2,status:'cancelled'});
    release({content:plan([],[{todoId:'one',expectedRevision:1,action:'complete',sourceQuote:'搞定了'}])});
    const result=await pending;assert.equal(result.changed.length,0);assert.equal(f.records.get('one')!.status,restore?'pending':'cancelled');
  }
});

test('complex no-model input is retained without a single swallowed task',async()=>{
  const f=fixture();const agent=createPersonalAgent({...f,now:()=>now});
  const result=await agent.capture({text:'提醒我买牛奶，周五发合同',space:'life',sourceId:'complex'});
  assert.equal(f.records.size,0);assert.ok(result.warning);
});

test('model context is bounded and space isolated',async()=>{
  const f=fixture([todo('life'),todo('work','work')]);let input:any;
  const agent=createPersonalAgent({...f,model:async value=>{input=value;return {content:plan()};},now:()=>now});
  await agent.capture({text:'帮我整理下这些',space:'life',sourceId:'ctx',useModel:true,turns:[{role:'user',content:'秘密',space:'work'},...Array.from({length:8},(_,i)=>({role:'user',content:`生活${i}`,space:'life'}))]});
  assert.equal(input.context.todos.length,1);assert.equal(input.context.turns.length,6);assert.ok(!JSON.stringify(input).includes('秘密'));
});

test('ordinary future plans stay suggested even if model calls them explicit',async()=>{
  const f=fixture();const agent=createPersonalAgent({...f,now:()=>now,model:async()=>({content:plan([task('买牛奶','明天去买牛奶')])})});
  const r=await agent.capture({text:'明天去买牛奶，顺便走走',space:'life',sourceId:'plan'});
  assert.equal(r.created[0].status,'suggested');
});

test('invalid later item prevents all writes and multi-change plan requires choice',async()=>{
  const f=fixture([todo(),{...todo('two'),title:'买牛奶'}]);
  const invalid=createPersonalAgent({...f,model:async()=>({content:plan([task('发合同'),task('不存在')])}),now:()=>now});
  await invalid.capture({text:'记一下发合同，买牛奶',space:'life',sourceId:'invalid'});assert.equal(f.records.size,2);
  const multi=createPersonalAgent({...f,model:async()=>({content:plan([],['one','two'].map(todoId=>({todoId,expectedRevision:1,action:'complete',sourceQuote:'都搞定了'})))}),now:()=>now});
  const r=await multi.capture({text:'这两件都搞定了',space:'life',sourceId:'multi',useModel:true});
  assert.equal(r.needsChoice?.length,2);assert.ok([...f.records.values()].every(t=>t.status==='pending'));
});

test('partial writes report saved state and retry never duplicates',async()=>{
  const f=fixture();const original=f.todos.create;let writes=0;
  f.todos.create=async value=>{if(++writes===2)throw Error('disk full');return original(value);};
  const agent=createPersonalAgent({...f,model:async()=>({content:plan([task('买牛奶'),task('发合同')])}),now:()=>now});
  const input={text:'记一下买牛奶，发合同',space:'life' as const,sourceId:'partial'};
  const r=await agent.capture(input);assert.equal(r.created.length,1);assert.match(r.warning!,/部分事项已保存/);
  const retry=await agent.capture(input);assert.equal(writes,3);assert.equal(f.records.size,2);assert.equal(retry.created.length,2);
});

test('model cannot invent dates for a clock-only request',()=>{
  assert.throws(()=>parseAgentPlan(plan([{...task('交电费','下午三点提醒我交电费'),dueAt:'2026-11-05T07:00:00Z'}]),{text:'下午三点提醒我交电费',space:'life',todos:[],now}));
});

test('mixed change actions never expose an actionable default-complete choice',async()=>{
  const f=fixture([todo(),todo('two')]);
  const agent=createPersonalAgent({...f,model:async()=>({content:plan([],[{todoId:'one',expectedRevision:1,action:'complete',sourceQuote:'搞定了'},{todoId:'two',expectedRevision:1,action:'rename',sourceQuote:'改名为买牛奶',title:'买牛奶'}])}),now:()=>now});
  const r=await agent.capture({text:'电费搞定了，另一件改名为买牛奶',space:'life',sourceId:'mixed'});
  assert.equal(r.needsChoice,undefined);assert.ok(r.warning);assert.equal(r.changed.length,0);
});

test('partial retry freezes model order rather than silently mismatching indexed IDs',async()=>{
  const f=fixture();const original=f.todos.create;let writes=0,calls=0;
  f.todos.create=async input=>{if(++writes===2)throw Error('disk full');return original(input);};
  const agent=createPersonalAgent({...f,model:async()=>({content:plan(++calls===1?[task('买牛奶'),task('发合同')]:[task('发合同'),task('买牛奶')])}),now:()=>now});
  const input={text:'记一下买牛奶，发合同',space:'life' as const,sourceId:'freeze'};
  await agent.capture(input);await agent.capture(input);
  assert.equal(calls,1);assert.equal(f.records.get('agent-freeze-0')?.title,'买牛奶');assert.equal(f.records.get('agent-freeze-1')?.title,'发合同');
});

test('reply-only business plan cannot suppress local review requirement',async()=>{
  const f=fixture();const agent=createPersonalAgent({...f,model:async()=>({content:JSON.stringify({version:1,items:[],changes:[],reply:'记住了',requiresBusinessReview:false})}),now:()=>now});
  const r=await agent.capture({text:'客户预算三万元，已经承诺本周成交',space:'work',sourceId:'risk'});assert.equal(r.needsReview,true);
});

test('missing action clause warns and retries model to fill omissions',async()=>{
  const f=fixture();let calls=0;const agent=createPersonalAgent({...f,model:async()=>({content:plan(++calls===1?[task('买牛奶')]:[task('买牛奶'),task('发合同')])}),now:()=>now});
  const input={text:'记一下买牛奶，发合同',space:'life' as const,sourceId:'omission'};
  const first=await agent.capture(input);assert.ok(first.warning);
  await agent.capture(input);assert.equal(calls,2);assert.equal(f.records.size,2);
});

test('polite time quote validates and rescheduling enables reminders before writing',async()=>{
  const f=fixture([todo()]);const order:string[]=[];const configure=f.todos.configure,update=f.todos.update;
  f.todos.configure=async enabled=>{order.push('configure');return configure(enabled);};f.todos.update=async(t,p)=>{order.push('update');return update(t,p);};
  const agent=createPersonalAgent({...f,model:async()=>({content:plan([],[{todoId:'one',expectedRevision:1,action:'reschedule',sourceQuote:'改到明天下午三点吧',dueAt:'2026-11-06T07:00:00Z'}])}),now:()=>now});
  const r=await agent.capture({text:'电费改到明天下午三点吧',space:'life',sourceId:'polite'});assert.equal(r.changed.length,1);assert.deepEqual(order,['configure','update']);
});

test('completion accepts clear processed/sent/paid words but rejects negations',()=>{
  for(const text of ['电费已处理','电费处理好了','合同已发','电费付清'])assert.doesNotThrow(()=>parseAgentPlan(plan([],[{todoId:'one',expectedRevision:1,action:'complete',sourceQuote:text}]),{text,space:'life',todos:[todo()],now}));
  for(const text of ['电费还没处理好','合同未发','电费没有付清'])assert.throws(()=>parseAgentPlan(plan([],[{todoId:'one',expectedRevision:1,action:'complete',sourceQuote:text}]),{text,space:'life',todos:[todo()],now}));
});

test('omission retry with reordered candidates stops on persisted ID conflict',async()=>{
  const f=fixture();let calls=0;
  const agent=createPersonalAgent({...f,model:async()=>({content:plan(++calls===1?[task('买牛奶')]:[task('发合同'),task('买牛奶')])}),now:()=>now});
  const input={text:'记一下买牛奶，发合同',space:'life' as const,sourceId:'conflict-order'};
  await agent.capture(input);const second=await agent.capture(input);
  assert.ok(second.warning);assert.equal(f.records.size,1);assert.equal(f.records.get('agent-conflict-order-0')?.title,'买牛奶');
});

test('pure business facts marked task by model remain review-only without creating a todo',async()=>{
  const f=fixture();const text='陈总确认项目预算三万元';
  const agent=createPersonalAgent({...f,model:async()=>({content:plan([task('项目预算三万元',text)])}),now:()=>now});
  const r=await agent.capture({text,space:'work',sourceId:'business-fact'});
  assert.equal(r.needsReview,true);assert.equal(f.records.size,0);
});

test('unfamiliar parallel actions still require every clause to be represented',async()=>{
  for(const [text,first] of [['记一下预约牙医，打印材料','预约牙医'],['记一下预约牙医和打印材料','预约牙医'],['记一下预约牙医，顺便复印身份证','预约牙医'],['记一下预约牙医，再领取快递','预约牙医']]){
    const f=fixture();const agent=createPersonalAgent({...f,model:async()=>({content:plan([task(first)])}),now:()=>now});
    const r=await agent.capture({text,space:'life',sourceId:text});
    assert.equal(r.modelUsed,true,text);assert.ok(r.warning,text);
  }
});

test('conjoined familiar actions never become one local-fast swallowed task',async()=>{
  const f=fixture();const agent=createPersonalAgent({...f,model:async()=>({content:plan([task('买牛奶'),task('发合同')])}),now:()=>now});
  const r=await agent.capture({text:'提醒我买牛奶和发合同',space:'life',sourceId:'conjoined'});
  assert.equal(r.modelUsed,true);assert.equal(r.created.length,2);assert.equal(f.records.size,2);
});

test('queued capture carrying old identity never calls model or writes',async()=>{
  const f=fixture();let identity='old';let calls=0;
  const agent=createPersonalAgent({...f,readIdentity:()=>identity,model:async()=>{calls++;return {content:plan([task('买牛奶')])};},now:()=>now});
  const capture=agent.capture({text:'提醒我买牛奶',space:'life',sourceId:'queued',expectedIdentity:'old'});
  identity='new';const result=await capture;
  assert.ok(result.warning);assert.equal(calls,0);assert.equal(f.records.size,0);
});

test('whole-context counterfactual questions and quotations do not invoke model or create tasks',async()=>{
  for(const text of ['我以为水费已经交了，结果没交','我以为电费交了，实际还没','举例说明买牛奶和发合同','水费是不是已经交了？','如果水费交了就好了','他说“电费已经交了”']){
    const f=fixture([todo()]);let calls=0;
    const agent=createPersonalAgent({...f,model:async()=>{calls++;return {content:plan([task('交水费',text)])};},now:()=>now});
    const r=await agent.capture({text,space:'life',sourceId:text});
    assert.equal(calls,0,text);assert.equal(r.created.length,0,text);assert.equal(f.records.get('one')?.status,'pending');assert.equal(f.records.size,1);
  }
});

test('a negated past statement does not suppress an explicit future reminder',async()=>{
  const f=fixture();let calls=0;const text='水费还没交，明天下午三点提醒我交水费';
  const agent=createPersonalAgent({...f,model:async()=>{calls++;return {content:plan([{...task('交水费','明天下午三点提醒我交水费'),dueAt:'2026-11-06T07:00:00Z'}])};},now:()=>now});
  const r=await agent.capture({text,space:'life',sourceId:'explicit-after-negative'});assert.equal(calls,1);assert.equal(r.created.length,1);assert.equal(r.created[0].status,'pending');
});

test('local work capture handles quote-related reminders, casual untimed todos, two-item captures and mixed reminders without false positives',async()=>{
  const f=fixture();
  const agent=createPersonalAgent({...f,now:()=>now});
  const timed=await agent.capture({text:'明天上午十点记得提醒我复核报价单草稿',space:'work',sourceId:'quote-timed'});
  assert.equal(timed.created.length,1);assert.equal(timed.created[0].status,'pending');assert.ok(timed.created[0].dueAt);assert.ok(timed.created[0].title.includes('复核报价单草稿'));
  const suggested=await agent.capture({text:'我后天下午两点打算核对客户报价明细',space:'work',sourceId:'quote-plan'});
  assert.equal(suggested.created.length,1);assert.equal(suggested.created[0].status,'suggested');assert.ok(suggested.created[0].dueAt);
  const casual=await agent.capture({text:'先记一下归档发票底联，暂时不用提醒',space:'work',sourceId:'casual-untimed'});
  assert.equal(casual.created.length,1);assert.equal(casual.created[0].status,'pending');assert.equal(casual.created[0].dueAt,undefined);assert.equal(casual.created[0].title,'归档发票底联');
  const pair=await agent.capture({text:'帮我记一下校对宣传册排版，顺便给周总监发样稿链接，都不设时间',space:'work',sourceId:'two-tasks'});
  assert.equal(pair.created.length,2);assert.deepEqual(pair.created.map(t=>t.title),['校对宣传册排版','给周总监发样稿链接']);assert.ok(pair.created.every(t=>t.status==='pending'&&!t.dueAt));
  const mixed=await agent.capture({text:'张总的园区改造项目预算暂定八万元，另外明天下午四点提醒我核对报价附件',space:'work',sourceId:'mixed-quote'});
  assert.equal(mixed.needsReview,true);assert.equal(mixed.created.length,1);assert.equal(mixed.created[0].status,'pending');assert.ok(mixed.created[0].dueAt);assert.equal(mixed.warning,undefined);
  const beforeCount=f.records.size;
  for(const [i,neg] of [
    '张总说下周把报价单发给我们，不用给我设提醒',
    '今天跟客户核对报价单，开完会实在太累了',
    '随手记个信息：张总平时喜欢喝冰美式',
    '要是报价单复核完了我再告诉你，先不要改',
  ].entries()){
    const res=await agent.capture({text:neg,space:'work',sourceId:`counter-${i}`});
    assert.equal(res.created.length,0,neg);assert.equal(res.changed.length,0,neg);
  }
  assert.equal(f.records.size,beforeCount);
});

test('work review draft distinguishes waiting on client vs unconfirmed questions, resolves named project among multi-project clients, and never guesses ambiguous or uncertain budgets',async()=>{
  const f=fixture();
  const agent=createPersonalAgent({...f,now:()=>now});
  const partition:WorkPartition={
    revision:1,messages:[],memories:[],journals:[],customCards:[],events:[],processedProposalIds:[],closures:[],tasks:[],followUps:[],
    engagements:[
      {id:'proj-sun-0',clientName:'孙师傅',title:'冷链冷库改造',budgetAmount:12000,stage:'需求确认',internalContext:'',shareableSummary:'',nextAction:'',updatedAt:now},
      {id:'proj-sun-1',clientName:'孙师傅',title:'备选维保合作',budgetAmount:12000,stage:'需求确认',internalContext:'',shareableSummary:'',nextAction:'',updatedAt:now},
      {id:'proj-he-0',clientName:'何女士',title:'品牌展厅升级',budgetAmount:15000,stage:'需求确认',internalContext:'',shareableSummary:'',nextAction:'',updatedAt:now},
      {id:'proj-he-1',clientName:'何女士',title:'备选咨询项目',budgetAmount:15000,stage:'需求确认',internalContext:'',shareableSummary:'',nextAction:'',updatedAt:now},
    ],
  };

  // 1. Waiting on client / counterparty promised date != user reminder
  for(const text of [
    '孙师傅说冷链冷库改造项目明天会把确认函发给我们，不用给我设提醒',
    '何女士答应周五给品牌展厅升级项目补齐合同附件，我这边先等',
  ]){
    const todoRes=await agent.capture({text,space:'work',sourceId:'wait-check'});
    assert.equal(todoRes.created.length,0,text);
    assert.equal(todoRes.needsReview,true,text);
    const prop=StateEngine.propose(text,{mode:'work',sourceMessageId:'wait-check',partition,now});
    assert.equal(prop.operations.some(op=>op.target==='task'),false,text);
    const waitOp=prop.operations.find(op=>op.target==='followup'&&op.after?.kind==='waiting');
    assert.ok(waitOp,text);
    assert.ok(waitOp.after?.expectedDate,text);
  }

  // 2. Unconfirmed project question -> followup kind 'question', no todo
  for(const text of [
    '孙师傅的冷链冷库改造项目报价含不含运费还没定，要核对',
    '何女士的品牌展厅升级项目税点怎么算还没敲定，先记个待确认问题',
  ]){
    const todoRes=await agent.capture({text,space:'work',sourceId:'q-check'});
    assert.equal(todoRes.created.length,0,text);
    assert.equal(todoRes.needsReview,true,text);
    const prop=StateEngine.propose(text,{mode:'work',sourceMessageId:'q-check',partition,now});
    assert.equal(prop.operations.some(op=>op.target==='followup'&&op.after?.kind==='question'),true,text);
  }

  // 3. Explicit budget & stage on multi-project client when project title is named
  const budgetProp=StateEngine.propose('孙师傅的冷链冷库改造项目预算确定为46000元，先整理一下',{mode:'work',sourceMessageId:'b-check',partition,now});
  assert.equal(budgetProp.operations.some(op=>op.target==='engagement'&&op.entityId==='proj-sun-0'&&op.after?.budgetAmount===46000),true);
  const stageProp=StateEngine.propose('何女士的品牌展厅升级项目阶段更新为商务谈判，先核对一下',{mode:'work',sourceMessageId:'s-check',partition,now});
  assert.equal(stageProp.operations.some(op=>op.target==='engagement'&&op.entityId==='proj-he-0'&&op.after?.stage==='商务谈判'),true);

  // 4. Counterexamples: ambiguous project (multi-project client without project title), tentative budget, negated budget, hypothetical stage
  for(const text of [
    '孙师傅那个项目预算改成十万元，具体哪个项目我还没说',
    '孙师傅说冷链冷库改造项目预算可能是四万元，我们还没确认',
    '何女士的品牌展厅升级项目不是六万元预算，这个数先不要当真',
    '如果何女士的品牌展厅升级项目下周成交就好了，实际还没签约',
  ]){
    const prop=StateEngine.propose(text,{mode:'work',sourceMessageId:'safe-check',partition,now});
    const bad=prop.operations.some(op=>op.target==='engagement'&&(op.after?.budgetAmount!==op.before?.budgetAmount||op.after?.stage==='赢单成交'));
    assert.equal(bad,false,text);
  }
});

test('colloquial non-template spoken Chinese handles Chinese numerals, inverted multi-todos, split-clause reminders and stripped client prefixes',async()=>{
  const f=fixture();
  const agent=createPersonalAgent({...f,now:()=>now});
  const partition:WorkPartition={
    revision:1,messages:[],memories:[],journals:[],customCards:[],events:[],processedProposalIds:[],closures:[],tasks:[],followUps:[],
    engagements:[
      {id:'p0',clientName:'陈总',title:'门店改版',budgetAmount:12000,stage:'需求确认',internalContext:'',shareableSummary:'',nextAction:'',updatedAt:now},
      {id:'p1',clientName:'陈总',title:'备选合作',budgetAmount:12000,stage:'需求确认',internalContext:'',shareableSummary:'',nextAction:'',updatedAt:now},
    ],
  };

  // 1. Shorthand & full Chinese numerals + colloquial budget verbs
  for(const [i,[text,expectedBudget]] of [
    ['陈总刚微信说门店改版的预算定死在三万五，让我先登记下',35000],
    ['陈总的门店改版项目预算改成三万八千元',38000],
    ['门店改版那个事，陈总把预算压到2.8万了',28000],
  ].entries() as IterableIterator<[number,[string,number]]>){
    const r=await agent.capture({text,space:'work',sourceId:`colloq-b-${i}`});
    assert.equal(r.created.length,0,text);
    assert.equal(r.needsReview,true,text);
    const p=StateEngine.propose(text,{mode:'work',sourceMessageId:`colloq-b-${i}`,partition,now});
    assert.equal(p.operations.some(o=>o.target==='engagement'&&o.entityId==='p0'&&o.after?.budgetAmount===expectedBudget),true,text);
    assert.equal(p.operations.some(o=>o.target==='followup'&&o.after?.kind==='waiting'),false,text);
  }

  // 2. Inverted two-item capture with 和 & 先别设闹钟
  const pair=await agent.capture({text:'把核对报价单和发会议纪要这两件事记一下，先别设闹钟',space:'work',sourceId:'colloq-pair'});
  assert.equal(pair.needsReview,false);
  assert.deepEqual(pair.created.map(x=>x.title),['核对报价单','发会议纪要']);
  assert.ok(pair.created.every(x=>x.status==='pending'&&!x.dueAt));

  // 3. Split-clause timed reminder with 叫我一下 + 发给陈总 (never invents bogus client project)
  const splitRemind=await agent.capture({text:'后天上午十点叫我一下，要把报价单发给陈总',space:'work',sourceId:'colloq-split-remind'});
  assert.equal(splitRemind.needsReview,false);
  assert.equal(splitRemind.created.length,1);
  assert.equal(splitRemind.created[0].title,'把报价单发给陈总');
  assert.equal(splitRemind.created[0].status,'pending');
  assert.equal(splitRemind.created[0].dueAt,'2026-11-07T02:00:00.000Z');

  // 4. Colloquial waiting & unconfirmed question
  for(const [i,[text,expectedDate]] of [
    ['门店改版这块，陈总那头说明天给答复，咱们先不动','2026-11-06'],
    ['陈总说门店改版项目下周三给我们打预付款，我先记一笔等着','2026-11-11'],
  ].entries() as IterableIterator<[number,[string,string]]>){
    const r=await agent.capture({text,space:'work',sourceId:`colloq-w-${i}`});
    assert.equal(r.created.length,0,text);
    assert.equal(r.needsReview,true,text);
    const p=StateEngine.propose(text,{mode:'work',sourceMessageId:`colloq-w-${i}`,partition,now});
    const waitOp=p.operations.find(o=>o.target==='followup'&&o.after?.kind==='waiting');
    assert.ok(waitOp,text);
    assert.equal(waitOp.after?.expectedDate,expectedDate,text);
  }

  const qText='陈总的门店改版项目，发票开几个点还没聊透';
  const qr=await agent.capture({text:qText,space:'work',sourceId:'colloq-q'});
  assert.equal(qr.created.length,0);
  assert.equal(qr.needsReview,true);
  const qp=StateEngine.propose(qText,{mode:'work',sourceMessageId:'colloq-q',partition,now});
  assert.equal(qp.operations.some(o=>o.target==='followup'&&o.after?.kind==='question'&&o.after?.title==='发票开几个点还没聊透'),true);

  // 5. Colloquial relative time (半个小时后 / 一个半小时后) &傍晚
  const halfHr=await agent.capture({text:'半个小时后提醒我复查测试环境',space:'work',sourceId:'colloq-half-hr'});
  assert.equal(halfHr.created.length,1);
  assert.equal(halfHr.created[0].title,'复查测试环境');
  assert.equal(halfHr.created[0].dueAt,new Date(now+30*60000).toISOString());

  const oneHalfHr=await agent.capture({text:'一个半小时后提醒我导出统计报表',space:'work',sourceId:'colloq-15-hr'});
  assert.equal(oneHalfHr.created.length,1);
  assert.equal(oneHalfHr.created[0].title,'导出统计报表');
  assert.equal(oneHalfHr.created[0].dueAt,new Date(now+90*60000).toISOString());

  // 6. Colloquial named work todo mutations (把...标为完成 / 把...的提醒取消掉 / 把...的提醒改到... / 把...的标题改成...)
  const doneRes=await agent.capture({text:'把复查测试环境标为完成',space:'work',sourceId:'colloq-done'});
  assert.equal(doneRes.changed.length,1);
  assert.equal(doneRes.changed[0].status,'completed');
  assert.equal(doneRes.silent,true);

  const moveRes=await agent.capture({text:'把导出统计报表的提醒改到大后天傍晚六点',space:'work',sourceId:'colloq-move'});
  assert.equal(moveRes.changed.length,1);
  assert.equal(moveRes.changed[0].dueAt,'2026-11-08T10:00:00.000Z');

  const renameRes=await agent.capture({text:'把导出统计报表的标题改成导出月度统计报表',space:'work',sourceId:'colloq-rename'});
  assert.equal(renameRes.changed.length,1);
  assert.equal(renameRes.changed[0].title,'导出月度统计报表');

  const cancelRes=await agent.capture({text:'把导出月度统计报表的提醒取消掉',space:'work',sourceId:'colloq-cancel'});
  assert.equal(cancelRes.changed.length,1);
  assert.equal(cancelRes.changed[0].status,'cancelled');

  // 7. Colloquial stage expressions (must also set needsReview=true in personalAgent so App routes to StateEngine.propose)
  const sr1=await agent.capture({text:'陈总的门店改版项目报价单刚发给客户',space:'work',sourceId:'colloq-stage-1'});
  assert.equal(sr1.needsReview,true);
  const stageQuote=StateEngine.propose('陈总的门店改版项目报价单刚发给客户',{mode:'work',sourceMessageId:'colloq-stage-1',partition,now});
  assert.equal(stageQuote.operations.some(o=>o.target==='engagement'&&o.entityId==='p0'&&o.after?.stage==='方案报价'),true);
  const sr2=await agent.capture({text:'陈总的门店改版项目进入砍价阶段了',space:'work',sourceId:'colloq-stage-2'});
  assert.equal(sr2.needsReview,true);
  const stageTalk=StateEngine.propose('陈总的门店改版项目进入砍价阶段了',{mode:'work',sourceMessageId:'colloq-stage-2',partition,now});
  assert.equal(stageTalk.operations.some(o=>o.target==='engagement'&&o.entityId==='p0'&&o.after?.stage==='商务谈判'),true);
});

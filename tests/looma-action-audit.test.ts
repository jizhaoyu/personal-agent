import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPersonalAgent } from '../src/services/personalAgent';
import { createTodoService } from '../src/services/todos';
import type { TodoRecord } from '../src/types';

type Fixture = {
  group: string; intent: string; text: string;
  tasks: { id: string; title: string; status: string }[];
  expected_task_mutation: null | { task_id: string; operation: string; new_title?: string };
};

test('isolated Looma action audit with explicit candidate plans', {skip: !existsSync('output/looma-synthetic-action-eval-24.jsonl')}, async () => {
  const cases: Fixture[] = readFileSync('output/looma-synthetic-action-eval-24.jsonl', 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(cases.length, 24);
  const now = Date.parse('2026-11-02T02:00:00Z');
  const expectedTimes: Record<string,string> = {
    m01: '2026-11-05T06:00:00.000Z',
    m02: '2026-11-02T10:20:00.000Z',
    m04: '2026-11-06T08:00:00.000Z',
  };
  const probeIds = new Set(['c05','c06','x04','m04']);
  const offlineIds = new Set(['c01','c02','c03','c04','x01','x02','m02']);
  const results = [];
  for (const fixture of cases) {
    const key = fixture.group.split('_').at(-1)!;
    const expected = fixture.expected_task_mutation;
    const initial: TodoRecord[] = fixture.tasks.map(t => ({
      id:t.id, title:t.title, status:t.status==='active'?'pending':'completed',
      space:'life', revision:1, createdAt:now, updatedAt:now, needsTime:false,
      ...(key==='m02'?{dueAt:'2026-11-02T10:00:00.000Z'}:{}),
    }));
    const records = new Map(initial.map(t => [t.id, structuredClone(t)]));
    const writes: string[] = [];
    const todos = createTodoService(async command => {
      if (command.op==='list') return {todos:[...records.values()].map(t=>structuredClone(t))};
      if (command.op==='put') {
        assert.equal(records.get(command.todo.id)?.revision??null,command.expectedRevision);
        writes.push(command.todo.id);
        records.set(command.todo.id,structuredClone(command.todo));
        return {todo:command.todo};
      }
      return {ok:true};
    },{now:()=>now});
    const target = expected?.task_id ?? (probeIds.has(key)?initial.find(t=>t.status==='pending')?.id:undefined);
    const action = expected ? ({completed:'complete',cancelled:'cancel',rescheduled:'reschedule',renamed:'rename'} as Record<string,string>)[expected.operation]
      : ({complete:'complete',cancel:'cancel',change:'reschedule'} as Record<string,string>)[fixture.intent];
    const changes = target ? [{
      todoId:target, expectedRevision:1, action, sourceQuote:fixture.text,
      ...(action==='rename'?{title:expected?.new_title}:{}),
      ...(action==='reschedule'?{dueAt:expectedTimes[key]}:{}),
    }] : [];
    let modelCalls=0;
    const agent=createPersonalAgent({todos,now:()=>now,model:async()=>{
      modelCalls++;
      return {content:JSON.stringify({version:1,items:[],changes,requiresBusinessReview:fixture.intent==='review'})};
    }});
    const result=await agent.capture({text:fixture.text,space:'life',sourceId:fixture.group,useModel:!offlineIds.has(key)});
    const final=[...records.values()];
    const changed=expected&&records.get(expected.task_id);
    const otherUnchanged=initial.filter(t=>t.id!==expected?.task_id).every(t=>JSON.stringify(t)===JSON.stringify(records.get(t.id)));
    const intended=expected?.operation;
    const passed=otherUnchanged&&final.length===initial.length&&(
      expected ? writes.length===1&&writes[0]===expected.task_id&&!!changed&&(
        intended==='completed'?changed.status==='completed':
        intended==='cancelled'?changed.status==='cancelled':
        intended==='renamed'?changed.title===expected.new_title&&changed.dueAt===initial.find(t=>t.id===changed.id)?.dueAt:
        changed.dueAt===expectedTimes[key]
      ) : writes.length===0
    );
    results.push({key,expected,probe:probeIds.has(key),passed,modelCalls,writes,warning:result.warning,needsReview:result.needsReview,initial,final});
  }
  const report={mode:'real service with memory port and injected plans; no live model, no live persistence',results};
  writeFileSync('output/looma-action-audit.json',JSON.stringify(report,null,2)+'\n');
  assert.equal(results.length,24);
  for (const key of ['c06','m04']) {
    assert.deepEqual(results.find(row=>row.key===key)?.writes,[],`${key}: must not write any todo`);
  }
  assert.equal(results.find(row=>row.key==='m01')?.passed,true,'an unambiguous reschedule still updates the existing todo');
  assert.deepEqual(results.filter(row=>!row.passed).map(row=>row.key),[]);
  assert.ok(results.every(row=>!offlineIds.has(row.key)||row.modelCalls===0));
});

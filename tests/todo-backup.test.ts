import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../src/persistence/repository';
import { DEFAULT_PUBLIC_SETTINGS, makeBootstrap } from '../shared/persistence-core.mjs';
const todo={id:'n1',space:'life',title:'交电费',status:'pending',revision:1,createdAt:1,updatedAt:1,dueAt:'2026-11-05T07:00:00Z'};
function fixture(){
  let records:any[]=[];let todos:any[]=[todo];let enabled=true;let reject=false;
  const port=async(c:any)=>{
    if(c.op==='list')return {ok:true,todos:structuredClone(todos)};
    if(c.op==='capabilities')return {ok:true,enabled};
    if(c.op==='configure'){enabled=c.enabled;return{ok:true};}
    if(c.op==='replaceAll'){if(reject){reject=false;return{ok:false,error:'native disk failure'};}todos=structuredClone(c.todos);return{ok:true};}
    throw Error(c.op);
  };
  const backend={async request(c:any):Promise<any>{
    if(c.op==='init')return{ready:true,mode:'life'};
    if(c.op==='bootstrap')return makeBootstrap({settings:DEFAULT_PUBLIC_SETTINGS,mode:'life',revisions:{life:0,work:0}},records,{space:c.space});
    if(c.op==='exportSnapshot')return{records:structuredClone(records),settings:{...DEFAULT_PUBLIC_SETTINGS,remindersEnabled:true},mode:'life',applied:[],revisions:{life:0,work:0},snapshotRevision:1};
    if(c.op==='restore'){records=structuredClone(c.records);return{ok:true};}
    throw Error(c.op);
  }};
  const repo=createRepository(backend,undefined,()=>port);
  return{repo,get todos(){return todos;},get records(){return records;},get enabled(){return enabled;},fail(){reject=true;}};
}
test('Android backup merges native todos and restoration splits them without losing records',async()=>{
  const f=fixture();const data=JSON.parse(await f.repo.exportAllData());assert.equal(data.records.length,1);assert.equal(data.records[0].kind,'todo');
  data.records[0].data.title='新电费';assert.equal(await f.repo.importAllData(JSON.stringify(data)),true);
  assert.equal(f.todos[0].title,'新电费');assert.equal(f.records.length,0);assert.equal(f.enabled,true);
});
test('Android invalid todo cannot replace either store and native failure rolls back ordinary records',async()=>{
  const f=fixture();const data=JSON.parse(await f.repo.exportAllData());data.records[0].data.revision=0;
  assert.equal(await f.repo.importAllData(JSON.stringify(data)),false);assert.equal(f.todos[0].title,'交电费');
  data.records[0].data.revision=1;data.records[0].data.title='未提交';f.fail();
  assert.equal(await f.repo.importAllData(JSON.stringify(data)),false);assert.equal(f.todos[0].title,'交电费');assert.equal(f.enabled,true);
});

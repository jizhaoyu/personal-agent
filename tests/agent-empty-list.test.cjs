const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateAgentContent}=require('../shared/agent-model.cjs');
test('real provider may omit the unused operation list, but an invalid supplied list is rejected',()=>{
 const input={text:'找时间交水费',context:{todos:[]}};
 const item={kind:'task',title:'交水费',intent:'explicit',sourceQuote:input.text};
 assert.deepEqual(JSON.parse(validateAgentContent(JSON.stringify({version:1,items:[item]}),input)),{version:1,items:[item],changes:[]});
 assert.throws(()=>validateAgentContent(JSON.stringify({version:1,items:[item],changes:null}),input));
 assert.throws(()=>validateAgentContent('{"version":1}',input));
});

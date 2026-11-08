const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('desktop capture uses trusted IPC and preload exposes the same channel',()=>{
  assert.match(fs.readFileSync('electron/main.cjs','utf8'),/handle\('model:captureAgent', value => services.captureAgentModel\(value\)\)/);
  assert.match(fs.readFileSync('electron/preload.cjs','utf8'),/captureAgentModel:.*invoke\('model:captureAgent'/);
});
test('Android capture bounds and whitelists context behind opt-in with a system prompt',()=>{
  const java=fs.readFileSync('android/app/src/main/java/com/looma/agent/LoomaBridge.java','utf8');
  assert.match(java,/public String captureAgentModel\(String payloadJson\)/);
  assert.match(java,/if \(!vault.isEnabled\(\)\)/);
  assert.match(java,/todos.length\(\) < 80/);
  assert.match(java,/turnsInput.length\(\) - 6/);
  assert.match(java,/"system"/);
  assert.match(java,/validateAgentContent/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createBootstrap, inventory } = require(path.join(process.cwd(), 'scripts/verify-personal-agent-exe.cjs'));

test('EXE bootstrap is syntactically valid, uses isolated paths and keeps instrumentation out of production', () => {
  const bootstrap = createBootstrap({ profile: 'C:\\Temp\\synthetic profile', backup: 'C:\\Temp\\backup.jsonl' });
  assert.doesNotThrow(() => new vm.Script(bootstrap));
  assert.match(bootstrap, /require\('\.\/electron\/main\.cjs'\)/);
  assert.match(bootstrap, /app\.setPath\('userData'/);
  assert.match(bootstrap, /HARNESS_INJECTED_SAVE_FAILURE/);
  assert.match(bootstrap, /new e\.Notification/);
  assert.doesNotMatch(bootstrap, /writeFileSync|unlinkSync|rmSync/);
});

test('package byte inventory detects mutation and is stable across an exact copy', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-inventory-test-'));
  try {
    const source = path.join(temp, 'source'), copy = path.join(temp, 'copy');
    fs.mkdirSync(source);fs.writeFileSync(path.join(source, 'synthetic.txt'), 'synthetic');
    fs.cpSync(source, copy, { recursive: true });
    assert.deepEqual(inventory(source), inventory(copy));
    fs.appendFileSync(path.join(copy, 'synthetic.txt'), 'changed');
    assert.notDeepEqual(inventory(source), inventory(copy));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

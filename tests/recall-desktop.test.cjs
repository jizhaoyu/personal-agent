const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDesktopServices } = require('../electron/desktop-services.cjs');
test('memory recall requires separate consent, bounds evidence and has no business write tools', async t => {
  let sent;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-recall-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const service = createDesktopServices({ userDataPath: directory, safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '根据当前项目，预算为12万元。[project-1]' } }] }) }; } });
  await service.saveModelConnection({ apiBaseUrl: 'http://localhost:11434/v1', modelName: 'test', enabled: true });
  await assert.rejects(() => service.recallModel({ requestId: 'r1', query: '预算', space: 'work', evidence: [] }), /授权/);
  const result = await service.recallModel({ requestId: 'r1', query: '预算', space: 'work', authorized: true,
    evidence: [{ id: 'project-1', kind: 'current', text: '预算120000元', secret: 'must-not-send' }] });
  assert.match(result.content, /12万元/);
  assert.equal(JSON.stringify(sent).includes('must-not-send'), false);
  assert.equal('tools' in sent, false);
  assert.match(sent.messages[0].content, /不执行|只读/);
  await assert.rejects(() => service.recallModel({ requestId: 'r2', query: '预算', space: 'work', authorized: true, evidence: Array(21).fill({ id: 'x', kind: 'fact', text: 'x' }) }), /格式|范围/);
});

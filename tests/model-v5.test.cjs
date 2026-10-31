const test = require('node:test');
const assert = require('node:assert/strict');
const { validateModelContent } = require('../electron/desktop-services.cjs');
test('native model boundary accepts optional v5 followups but rejects private fields, invalid dates and reminders', () => {
  const base = { engagements: [], tasks: [], warnings: [] };
  const content = { ...base, followups: [{ kind: 'waiting', engagementId: 'p', title: '补素材', expectedDate: '2026-11-02', sourceDateText: '下周一' }] };
  assert.deepEqual(JSON.parse(validateModelContent(JSON.stringify(content))), content);
  assert.deepEqual(JSON.parse(validateModelContent(JSON.stringify(base))), base);
  for (const item of [
    { ...content.followups[0], internalContext: 'secret' },
    { ...content.followups[0], expectedDate: '2026-02-31' },
    { ...content.followups[0], kind: 'doTool' },
    { ...content.followups[0], reviewAt: '2026-11-02T01:00:00Z' },
  ]) assert.throws(() => validateModelContent(JSON.stringify({ ...base, followups: [item] })));
});

test('native model boundary rejects impossible timestamp days for tasks and customer expectations', () => {
  const base = { engagements: [], tasks: [], warnings: [] };
  assert.throws(() => validateModelContent(JSON.stringify({ ...base, tasks: [{ title: '发原型', dueAt: '2026-02-31T01:00:00Z' }] })));
  assert.throws(() => validateModelContent(JSON.stringify({ ...base, followups: [{ kind: 'waiting', title: '补素材', expectedAt: '2026-02-31T07:00:00Z' }] })));
});

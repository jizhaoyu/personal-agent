import { test } from 'node:test';
import assert from 'node:assert/strict';
let buildTrialReport: any;
try { ({ buildTrialReport } = require('../src/services/trialInfo')); } catch { /* RED: behavior assertion below. */ }
const buildInfo = { productVersion: '5.1.0', buildId: 'trial-20261029-a1b2c3', builtAt: '2026-10-29T01:00:00Z', channel: 'internal-validation' };
const context = { mode: 'work', phase: 'review', hasError: true };
const at = Date.parse('2026-10-29T02:00:00Z');

test('default trial report includes only public build and coarse operation context', () => {
  assert.equal(typeof buildTrialReport, 'function');
  const report = buildTrialReport({ buildInfo: { ...buildInfo, apiKey: 'secret-key', apiBaseUrl: 'https://private.example/v1' },
    context: { ...context, sourceText: '客户张三报价八万', error: 'C:\\private\\customer.sqlite', engagementId: 'private-customer-id' },
    snapshot: { internalContext: 'private margin' } }, at);
  assert.match(report, /trial-20261029-a1b2c3/); assert.match(report, /工作空间/); assert.match(report, /核对内容/);
  assert.match(report, /UI_ERROR_PRESENT/); assert.match(report, /2026-10-29T02:00:00.000Z/);
  assert.doesNotMatch(report, /secret-key|private\.example|客户张三|customer\.sqlite|private-customer-id|private margin|apiKey|apiBaseUrl/);
});
test('only explicitly entered feedback fields are added and unrecognized details are omitted', () => {
  assert.equal(typeof buildTrialReport, 'function');
  const blank = buildTrialReport({ buildInfo, context: { ...context, hasError: false } }, at);
  assert.match(blank, /NONE/); assert.match(blank, /尚未填写/);
  const report = buildTrialReport({ buildInfo, context, details: { expected: '希望回到刚才的草稿', actual: '返回后只看到首页', repeatability: 'yes', rawLogs: 'private raw logs', apiKey: 'secret-user-key' } }, at);
  assert.match(report, /希望回到刚才的草稿/); assert.match(report, /返回后只看到首页/); assert.match(report, /可以重复/);
  assert.doesNotMatch(report, /private raw logs|secret-user-key/);
});
test('malformed context and metadata do not turn into raw diagnostic payload', () => {
  assert.equal(typeof buildTrialReport, 'function');
  const report = buildTrialReport({ buildInfo: { ...buildInfo, buildId: 'https://private.example/key', builtAt: 'C:\\private\\config' },
    context: { mode: 'private business text', phase: 'raw stack: secret', hasError: 'secret value' }, details: { repeatability: 'raw-secret-enum' } }, at);
  assert.doesNotMatch(report, /private\.example|private\\config|private business text|raw stack|secret value|raw-secret-enum/);
  assert.match(report, /未知/); assert.match(report, /未确定/);
});

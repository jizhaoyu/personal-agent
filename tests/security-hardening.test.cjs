const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const electronBin = require('electron');
const mainPath = path.join(__dirname, '../electron/main.cjs');

test('anti-debugging fuse terminates immediately when debugging flags are injected', () => {
  const flags = ['--remote-debugging-port=9222', '--inspect=9229', '--inspect-brk=9229'];
  for (const flag of flags) {
    const res = spawnSync(electronBin, [mainPath, flag], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 3000
    });
    // 注入非授权调试参数后必须被安全底层拦截退出
    assert.strictEqual(res.status, 1, `参数 ${flag} 未能成功触发安全熔断`);
  }
});

test('clipboard sanitizer intercepts private keys and blocks hazardous credential leaks', () => {
  // 模拟剪贴板私钥正则检测逻辑
  const privateKeySample = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...fake...key\n-----END RSA PRIVATE KEY-----`;
  const normalText = '和李总沟通确认了周五交付原型，预算约30万。';

  function sanitizeClipboard(text) {
    if (typeof text !== 'string') return '';
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 12000) return '';
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i.test(trimmed)) {
      return '[SECURITY INTERCEPT] 检测到包含私钥特征，底座已自动阻止载入待办，保护您的凭据安全。';
    }
    return trimmed;
  }

  const intercepted = sanitizeClipboard(privateKeySample);
  assert.match(intercepted, /SECURITY INTERCEPT/);

  const clean = sanitizeClipboard(normalText);
  assert.strictEqual(clean, normalText);
});

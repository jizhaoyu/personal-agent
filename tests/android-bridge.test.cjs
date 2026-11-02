const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadAndroidBridgeModule() {
  const compiledPath = path.join(__dirname, '../src/services/androidBridge.js');
  if (fs.existsSync(compiledPath)) {
    return require(compiledPath);
  }
  const ts = require('typescript');
  const tsPath = path.join(__dirname, '../src/services/androidBridge.ts');
  const source = fs.readFileSync(tsPath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const fn = new Function('exports', 'require', 'module', output);
  fn(mod.exports, require, mod);
  return mod.exports;
}

const { installAndroidBridge, sanitizeAndroidClipboard } = loadAndroidBridgeModule();

test('android bridge mounts window.electronAPI from window.LoomaAndroid and enforces FLAG_SECURE & clipboard defense', async () => {
  let flagSecureState = true;
  let clipboardContent = '与王总确认周五下午签约，合同预算50万';
  let vaultState = {
    configured: false,
    persistent: true,
    enabled: false,
    apiBaseUrl: 'https://api.deepseek.com/v1',
    modelName: 'deepseek-chat',
  };

  const fakeWindow = {
    LoomaAndroid: {
      readClipboard: () => clipboardContent,
      setContentProtection: (enabled) => {
        flagSecureState = !!enabled;
        return flagSecureState;
      },
      isContentProtected: () => flagSecureState,
      getModelStatus: () => JSON.stringify(vaultState),
      saveModelConnection: (payloadJson) => {
        const parsed = JSON.parse(payloadJson);
        vaultState = {
          configured: !!parsed.apiKey || vaultState.configured,
          persistent: true,
          enabled: !!parsed.enabled,
          apiBaseUrl: parsed.apiBaseUrl,
          modelName: parsed.modelName,
        };
        return JSON.stringify(vaultState);
      },
      clearModelConnection: () => {
        vaultState.configured = false;
        vaultState.enabled = false;
        return JSON.stringify({ cleared: true });
      },
      proposeModel: () => JSON.stringify({ content: '{"operations":[]}' }),
      recallModel: () => JSON.stringify({ content: '无冲突记录' }),
      notifyDue: (count) => count > 0,
      minimizeApp: () => {},
      closeApp: () => {},
    },
  };

  const mounted = installAndroidBridge(fakeWindow);
  assert.equal(mounted, true);
  assert.ok(fakeWindow.electronAPI);

  // 1. 验证正常剪贴板读取
  assert.equal(await fakeWindow.electronAPI.readClipboard(), '与王总确认周五下午签约，合同预算50万');

  // 2. 验证私钥剪贴板高危阻断
  clipboardContent = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----';
  const intercepted = await fakeWindow.electronAPI.readClipboard();
  assert.match(intercepted, /SECURITY INTERCEPT/);
  assert.match(sanitizeAndroidClipboard(clipboardContent), /SECURITY INTERCEPT/);

  // 3. 验证 FLAG_SECURE 防截屏开关桥接
  assert.equal(await fakeWindow.electronAPI.isContentProtected(), true);
  assert.equal(await fakeWindow.electronAPI.setContentProtection(false), false);
  assert.equal(await fakeWindow.electronAPI.isContentProtected(), false);

  // 4. 验证 AndroidKeyStore 硬件凭据状态与模型调用桥接
  const saved = await fakeWindow.electronAPI.saveModelConnection({
    apiBaseUrl: 'https://api.deepseek.com/v1',
    modelName: 'deepseek-chat',
    apiKey: 'sk-android-test-key',
    enabled: true,
  });
  assert.equal(saved.configured, true);
  assert.equal(saved.enabled, true);

  const proposal = await fakeWindow.electronAPI.proposeModel({
    text: '测试输入',
    context: null,
    now: new Date().toISOString(),
  });
  assert.equal(proposal.content, '{"operations":[]}');
});

test('android asset sync generates SHA-256 tamper manifest for WebView bundle', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-android-sync-'));
  try {
    const distDir = path.join(tmp, 'dist');
    const assetsWwwDir = path.join(tmp, 'android/app/src/main/assets/www');
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>Looma</body></html>');
    fs.writeFileSync(path.join(distDir, 'assets/app.js'), 'console.log("looma-android");');

    const syncScriptPath = path.resolve(process.cwd(), 'scripts/sync-android.cjs');
    const { syncAndroidAssets } = require(syncScriptPath);
    const manifest = syncAndroidAssets({ rootDir: tmp, distDir, assetsWwwDir });

    assert.equal(manifest.fileCount, 2);
    assert.equal(manifest.algorithm, 'SHA-256');
    assert.equal(typeof manifest.files['index.html'], 'string');
    assert.equal(manifest.files['index.html'].length, 64);
    assert.equal(typeof manifest.files['assets/app.js'], 'string');
    assert.ok(fs.existsSync(path.join(assetsWwwDir, 'asset-hashes.json')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

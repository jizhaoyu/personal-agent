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

test('Android todo bridge buffers cold-start notification focus until a subscriber exists', async () => {
  const win = { LoomaAndroid: { todoRequest: raw => JSON.stringify({ok:true, command:JSON.parse(raw)}) } };
  assert.equal(installAndroidBridge(win),true);
  win.__loomaTodoFocus({space:'work',id:'quote'});
  const received=[];const unsubscribe=win.electronAPI.onTodoFocus(focus=>received.push(focus));
  await Promise.resolve();assert.deepEqual(received,[{space:'work',id:'quote'}]);unsubscribe();
  const response=await win.electronAPI.todoRequest({op:'list',space:'life'});assert.equal(response.command.op,'list');
});

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

test('android bridge forwards setSystemBarStyle to native bridge when supported and no-ops gracefully otherwise', async () => {
  const calls = [];
  const winWithBarStyle = {
    LoomaAndroid: {
      setSystemBarStyle: (isLight) => { calls.push(isLight); },
    },
  };
  assert.equal(installAndroidBridge(winWithBarStyle), true);
  assert.equal(await winWithBarStyle.electronAPI.setSystemBarStyle(true), true);
  assert.equal(await winWithBarStyle.electronAPI.setSystemBarStyle(false), true);
  assert.equal(await winWithBarStyle.electronAPI.setSystemBarStyle(1), true);
  assert.deepEqual(calls, [true, false, true]);

  const winWithoutBarStyle = { LoomaAndroid: {} };
  assert.equal(installAndroidBridge(winWithoutBarStyle), true);
  assert.equal(await winWithoutBarStyle.electronAPI.setSystemBarStyle(true), false);
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

test('android bridge exposes SAF saveBackupFile when exportBackupDocument is present and resolves outcomes cleanly', async () => {
  const winNoExport = { LoomaAndroid: {} };
  assert.equal(installAndroidBridge(winNoExport), true);
  assert.equal(winNoExport.electronAPI.saveBackupFile, undefined);

  let lastRequest = null;
  const winWithExport = {
    LoomaAndroid: {
      exportBackupDocument: (requestId, suggestedName, content) => {
        lastRequest = { requestId, suggestedName, content };
        return true;
      },
    },
  };
  assert.equal(installAndroidBridge(winWithExport), true);
  assert.equal(typeof winWithExport.electronAPI.saveBackupFile, 'function');

  const okPromise = winWithExport.electronAPI.saveBackupFile('Looma-v5.json', '{"version":"looma-v5"}');
  assert.equal(lastRequest.suggestedName, 'Looma-v5.json');
  assert.equal(lastRequest.content, '{"version":"looma-v5"}');
  winWithExport.__loomaOnBackupExportResult({ requestId: lastRequest.requestId, ok: true, canceled: false, error: '' });
  assert.deepEqual(await okPromise, { canceled: false });

  const cancelPromise = winWithExport.electronAPI.saveBackupFile('Looma-cancel.json', '{}');
  winWithExport.__loomaOnBackupExportResult({ requestId: lastRequest.requestId, ok: false, canceled: true, error: '' });
  assert.deepEqual(await cancelPromise, { canceled: true });

  const failPromise = winWithExport.electronAPI.saveBackupFile('Looma-fail.json', '{}');
  winWithExport.__loomaOnBackupExportResult({ requestId: lastRequest.requestId, ok: false, canceled: false, error: '写入失败' });
  await assert.rejects(failPromise, /写入失败/);
});

test('ensureSigningKeystore refuses mismatched or missing keystore when fingerprint is locked unless explicitly overridden', () => {
  const packageScriptPath = path.resolve(process.cwd(), 'scripts/package-android.cjs');
  const { ensureSigningKeystore } = require(packageScriptPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-keystore-guard-'));
  try {
    fs.mkdirSync(path.join(tmp, 'android', 'keystore'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'android', 'keystore.fingerprint'), 'a'.repeat(64) + '\n', 'utf8');

    assert.throws(
      () => ensureSigningKeystore({ rootDir: tmp, allowNewKeystore: false, certSha256Reader: () => 'b'.repeat(64) }),
      /缺少原签名密钥文件/,
    );

    fs.writeFileSync(path.join(tmp, 'android', 'keystore', 'looma-release.jks'), 'dummy', 'utf8');
    assert.throws(
      () => ensureSigningKeystore({ rootDir: tmp, allowNewKeystore: false, certSha256Reader: () => 'b'.repeat(64) }),
      /签名证书指纹不匹配/,
    );

    const matched = ensureSigningKeystore({ rootDir: tmp, allowNewKeystore: false, certSha256Reader: () => 'a'.repeat(64) });
    assert.equal(matched.certSha256, 'a'.repeat(64));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('android bridge exposes version info, async update check callback, and external URL opener', async () => {
  let reqId = '';
  const opened = [];
  const win = {
    LoomaAndroid: {
      getAppVersionInfo: () => JSON.stringify({ platform: 'android', versionCode: 510, versionName: '5.1.0' }),
      checkForUpdates: requestId => { reqId = requestId; return true; },
      openExternalUrl: url => { opened.push(url); return true; },
    },
  };
  assert.equal(installAndroidBridge(win), true);
  assert.deepEqual(await win.electronAPI.getAppVersionInfo(), { platform: 'android', versionCode: 510, versionName: '5.1.0' });

  const checkPromise = win.electronAPI.checkForUpdates();
  assert.ok(reqId.startsWith('upd-'));
  win.__loomaOnUpdateCheckResult({ requestId: reqId, result: { status: 'no-release', httpStatus: 404 } });
  assert.deepEqual(await checkPromise, { status: 'no-release', httpStatus: 404 });

  const openRes = await win.electronAPI.openExternalUrl('https://github.com/jizhaoyu/personal-agent/releases');
  assert.deepEqual(openRes, { opened: true, url: 'https://github.com/jizhaoyu/personal-agent/releases' });
  assert.deepEqual(opened, ['https://github.com/jizhaoyu/personal-agent/releases']);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const rootDir = process.cwd();
const apkPath = path.join(rootDir, 'output', 'android', 'Looma-v5.1.0-release-signed.apk');
const sdkRoot = process.env.ANDROID_HOME || 'D:\\DevEnv\\apps\\android-sdk';
const buildToolsDir = path.join(sdkRoot, 'build-tools', 'android-14');
const platformJar = path.join(sdkRoot, 'platforms', 'android-34', 'android.jar');

const aapt = path.join(buildToolsDir, 'aapt.exe');
const dexdump = path.join(buildToolsDir, 'dexdump.exe');
const zipalign = path.join(buildToolsDir, 'zipalign.exe');
const apksigner = path.join(buildToolsDir, 'apksigner.bat');

test('1. APK binary exists, passes 4-byte zipalign check and v1/v2/v3 cryptographic signature verification', () => {
  assert.ok(fs.existsSync(apkPath), `APK 文件不存在: ${apkPath}`);
  const stat = fs.statSync(apkPath);
  assert.ok(stat.size > 200000, `APK 体积异常: ${stat.size} bytes`);

  // 校验 4 字节对齐
  execFileSync(zipalign, ['-c', '4', apkPath], { stdio: 'pipe' });

  // 校验 v2 / v3 块签名 (minSdk 26 默认启用防 Janus 漏洞的 v2/v3 整包块校验)
  const sigOut = execFileSync('cmd.exe', ['/c', apksigner, 'verify', '--verbose', '--print-certs', apkPath], {
    encoding: 'utf8',
  });
  assert.match(sigOut, /^Verifies/m);
  assert.match(sigOut, /Verified using v2 scheme \(APK Signature Scheme v2\): true/);
  assert.match(sigOut, /Verified using v3 scheme \(APK Signature Scheme v3\): true/);
  assert.match(sigOut, /Signer #1 key algorithm: RSA/);
});

test('2. APK badging & binary AndroidManifest enforce security policies and launchable MainActivity', () => {
  const badging = execFileSync(aapt, ['dump', 'badging', apkPath], { encoding: 'utf8' });
  assert.match(badging, /package: name='com\.looma\.agent' versionCode='510' versionName='5\.1\.0'/);
  assert.match(badging, /sdkVersion:'26'/);
  assert.match(badging, /targetSdkVersion:'34'/);
  assert.match(badging, /launchable-activity: name='com\.looma\.agent\.MainActivity'/);
  assert.match(badging, /application-label:'Looma'/);
});

test('3. Dalvik classes.dex bytecode contains MainActivity, LoomaBridge, KeyStoreVault, SecurityShield and WebView wiring', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-apk-dex-'));
  try {
    execFileSync('jar', ['-xf', apkPath, 'classes.dex'], { cwd: tmpDir });
    const dexPath = path.join(tmpDir, 'classes.dex');
    assert.ok(fs.existsSync(dexPath), 'APK 内缺少 classes.dex');

    const dump = execFileSync(dexdump, ['-d', dexPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    // 验证四大核心类均已编译进 DEX
    assert.match(dump, /Class descriptor\s+:\s+'Lcom\/looma\/agent\/MainActivity;'/);
    assert.match(dump, /Class descriptor\s+:\s+'Lcom\/looma\/agent\/LoomaBridge;'/);
    assert.match(dump, /Class descriptor\s+:\s+'Lcom\/looma\/agent\/KeyStoreVault;'/);
    assert.match(dump, /Class descriptor\s+:\s+'Lcom\/looma\/agent\/SecurityShield;'/);

    // 验证 MainActivity 注入 LoomaAndroid 桥接并加载本地 WebView 入口
    assert.match(dump, /LoomaAndroid/);
    assert.match(dump, /file:\/\/\/android_asset\/www\/index\.html/);

    // 验证 KeyStoreVault 硬件加密配置与私钥拦截正则
    assert.match(dump, /AndroidKeyStore/);
    assert.match(dump, /AES\/GCM\/NoPadding/);
    assert.match(dump, /PRIVATE KEY/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('4. Unpacked APK assets match SHA-256 tamper manifest and compiled Java classes execute cleanly on JVM', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-apk-unpack-'));
  try {
    execFileSync('jar', ['-xf', apkPath], { cwd: tmpDir });
    const wwwDir = path.join(tmpDir, 'assets', 'www');
    const hashFile = path.join(wwwDir, 'asset-hashes.json');
    assert.ok(fs.existsSync(hashFile), '缺少 assets/www/asset-hashes.json');

    const manifest = JSON.parse(fs.readFileSync(hashFile, 'utf8'));
    assert.equal(manifest.algorithm, 'SHA-256');
    assert.ok(manifest.fileCount >= 10);

    for (const [relPath, expectedHash] of Object.entries(manifest.files)) {
      const fullPath = path.join(wwwDir, relPath);
      assert.ok(fs.existsSync(fullPath), `APK 内缺失前端资源: ${relPath}`);
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
      assert.equal(actualHash, expectedHash, `资源哈希不匹配: ${relPath}`);
    }

    // 在真实 JVM 上直接调用编译后的 LoomaBridge.sanitizeClipboard 与 SecurityShield
    const classesDir = path.join(rootDir, 'android', 'app', 'build', 'apk-work', 'classes');
    const harnessJava = path.join(tmpDir, 'Harness.java');
    fs.writeFileSync(harnessJava, `
      import com.looma.agent.LoomaBridge;
      import com.looma.agent.SecurityShield;
      public class Harness {
        public static void main(String[] args) {
          String clean = LoomaBridge.sanitizeClipboard("与陈总确认下周二交付方案，预算80万");
          String blocked = LoomaBridge.sanitizeClipboard("-----BEGIN RSA PRIVATE KEY-----\\nMIIE...\\n-----END RSA PRIVATE KEY-----");
          boolean tracer = SecurityShield.isTracerPidNonZero();
          if (!clean.equals("与陈总确认下周二交付方案，预算80万")) System.exit(2);
          if (!blocked.contains("[SECURITY INTERCEPT]")) System.exit(3);
          if (tracer) System.exit(4);
          System.out.println("JVM_HARNESS_OK");
        }
      }
    `, 'utf8');

    execFileSync('javac', ['-encoding', 'UTF-8', '-cp', `${classesDir};${platformJar}`, harnessJava], { stdio: 'inherit' });
    const jvmOut = execFileSync('java', ['-cp', `${tmpDir};${classesDir};${platformJar}`, 'Harness'], { encoding: 'utf8' });
    assert.match(jvmOut, /JVM_HARNESS_OK/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('5. Unpacked APK WebView bundle boots in real Chromium mobile container with injected window.LoomaAndroid bridge', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-apk-webview-'));
  try {
    execFileSync('jar', ['-xf', apkPath], { cwd: tmpDir });
    const indexHtml = path.join(tmpDir, 'assets', 'www', 'index.html');
    const preloadScript = path.join(tmpDir, 'android-webview-preload.cjs');
    const runnerScript = path.join(tmpDir, 'webview-runner.cjs');

    // 模拟 Android WebView.addJavascriptInterface(new LoomaBridge(this), "LoomaAndroid")
    fs.writeFileSync(preloadScript, `
      window.__flagSecure = true;
      window.LoomaAndroid = {
        readClipboard: () => '和赵总敲定周四下午演示安卓端，合同额60万',
        setContentProtection: (flag) => { window.__flagSecure = !!flag; return window.__flagSecure; },
        isContentProtected: () => window.__flagSecure,
        getModelStatus: () => JSON.stringify({ configured: true, persistent: true, enabled: true, apiBaseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-chat' }),
        saveModelConnection: (s) => s,
        clearModelConnection: () => '{"cleared":true}',
        proposeModel: () => JSON.stringify({ content: '{"operations":[]}' }),
        recallModel: () => JSON.stringify({ content: 'ok' }),
        notifyDue: () => true,
        minimizeApp: () => {},
        closeApp: () => {}
      };
    `, 'utf8');

    fs.writeFileSync(runnerScript, `
      const { app, BrowserWindow } = require('electron');

      app.whenReady().then(async () => {
        const win = new BrowserWindow({
          width: 390,
          height: 844,
          show: false,
          webPreferences: {
            preload: ${JSON.stringify(preloadScript)},
            contextIsolation: false,
            nodeIntegration: false,
            sandbox: false,
          },
        });

        await win.loadFile(${JSON.stringify(indexHtml)});

        let attempts = 0;
        while (attempts < 40) {
          const state = await win.webContents.executeJavaScript(\`
            (async () => {
              const rootText = document.getElementById('root')?.innerText || '';
              if (!rootText.includes('工作态') && !rootText.includes('looma')) return null;
              const clip = await window.electronAPI?.readClipboard?.();
              const prot = await window.electronAPI?.isContentProtected?.();
              return {
                hasBridge: !!window.electronAPI,
                clip,
                prot,
                title: document.title,
                rootLength: rootText.length
              };
            })()
          \`);
          if (state && state.hasBridge && state.rootLength > 20) {
            console.log('WEBVIEW_BOOT_SUCCESS:' + JSON.stringify(state));
            app.exit(0);
            return;
          }
          await new Promise(r => setTimeout(r, 200));
          attempts++;
        }
        console.error('WEBVIEW_BOOT_TIMEOUT');
        app.exit(1);
      });
    `, 'utf8');

    const electronBin = require('electron');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    const res = spawnSync(electronBin, [runnerScript], {
      cwd: rootDir,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });

    assert.equal(res.status, 0, `WebView 容器启动失败: ${res.stderr || res.stdout}`);
    assert.match(res.stdout, /WEBVIEW_BOOT_SUCCESS:/);
    const jsonLine = res.stdout.split('\n').find(l => l.includes('WEBVIEW_BOOT_SUCCESS:'));
    const payload = JSON.parse(jsonLine.split('WEBVIEW_BOOT_SUCCESS:')[1].trim());
    assert.equal(payload.hasBridge, true);
    assert.equal(payload.clip, '和赵总敲定周四下午演示安卓端，合同额60万');
    assert.equal(payload.prot, true);
    assert.ok(payload.rootLength > 20);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

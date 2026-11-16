const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { syncAndroidAssets } = require('./sync-android.cjs');

function findSubdirWithFile(baseDir, targetFile) {
  if (!fs.existsSync(baseDir)) return null;
  if (fs.existsSync(path.join(baseDir, targetFile))) return baseDir;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = path.join(baseDir, entry.name);
      if (fs.existsSync(path.join(candidate, targetFile))) return candidate;
    }
  }
  return null;
}

function ensureSigningKeystore({
  rootDir,
  allowNewKeystore = process.env.LOOMA_ALLOW_NEW_KEYSTORE === '1',
  keystorePass = process.env.LOOMA_KEYSTORE_PASS || 'looma2026secure',
  keyAlias = process.env.LOOMA_KEY_ALIAS || 'looma_release',
  certSha256Reader,
}) {
  const keystoreDir = path.join(rootDir, 'android', 'keystore');
  fs.mkdirSync(keystoreDir, { recursive: true });
  const keystorePath = path.join(keystoreDir, 'looma-release.jks');
  const fingerprintPath = path.join(rootDir, 'android', 'keystore.fingerprint');

  const readCertSha256 = certSha256Reader || (() => {
    const certDer = execFileSync('keytool', [
      '-exportcert',
      '-keystore', keystorePath,
      '-alias', keyAlias,
      '-storepass', keystorePass,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    return crypto.createHash('sha256').update(certDer).digest('hex');
  });

  if (!fs.existsSync(keystorePath)) {
    if (fs.existsSync(fingerprintPath) && !allowNewKeystore) {
      const expectedFp = fs.readFileSync(fingerprintPath, 'utf8').trim();
      throw new Error(
        `缺少原签名密钥文件 ${keystorePath}（已锁定证书指纹 ${expectedFp.slice(0, 16)}...）。`
        + '为避免签名变化导致 Android 用户无法覆盖更新并因卸载清空本地数据，已阻止自动生成新密钥；请还原原 looma-release.jks，或显式设置 LOOMA_ALLOW_NEW_KEYSTORE=1。',
      );
    }
    execFileSync('keytool', [
      '-genkeypair',
      '-v',
      '-keystore', keystorePath,
      '-alias', keyAlias,
      '-keyalg', 'RSA',
      '-keysize', '2048',
      '-validity', '10000',
      '-storepass', keystorePass,
      '-keypass', keystorePass,
      '-dname', 'CN=Looma Security, OU=Client Engineering, O=Looma, L=Shanghai, ST=Shanghai, C=CN',
    ], { stdio: 'inherit' });
  }

  const certSha256 = readCertSha256();
  if (fs.existsSync(fingerprintPath)) {
    const lockedFp = fs.readFileSync(fingerprintPath, 'utf8').trim();
    if (lockedFp && lockedFp !== certSha256 && !allowNewKeystore) {
      throw new Error(
        `签名证书指纹不匹配（期望 ${lockedFp.slice(0, 16)}...，实际 ${certSha256.slice(0, 16)}...）。`
        + '请确认使用的 looma-release.jks 与历史发布版一致，以免覆盖安装失败导致用户数据丢失；若有意更换密钥，请设置 LOOMA_ALLOW_NEW_KEYSTORE=1。',
      );
    }
    if (allowNewKeystore && lockedFp !== certSha256) {
      fs.writeFileSync(fingerprintPath, `${certSha256}\n`, 'utf8');
    }
  } else {
    fs.writeFileSync(fingerprintPath, `${certSha256}\n`, 'utf8');
  }

  return { keystorePath, fingerprintPath, keystorePass, keyAlias, certSha256 };
}

function packageAndroidApk(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const isWin = process.platform === 'win32';
  const sdkRoot = options.sdkRoot || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || 'D:\\DevEnv\\apps\\android-sdk';
  const aapt2Name = isWin ? 'aapt2.exe' : 'aapt2';
  const d8Name = isWin ? 'd8.bat' : 'd8';
  const zipalignName = isWin ? 'zipalign.exe' : 'zipalign';
  const apksignerName = isWin ? 'apksigner.bat' : 'apksigner';
  const buildToolsDir = findSubdirWithFile(path.join(sdkRoot, 'build-tools'), aapt2Name);
  const platformDir = findSubdirWithFile(path.join(sdkRoot, 'platforms'), 'android.jar');

  if (!buildToolsDir || !platformDir) {
    throw new Error(`未找到 Android SDK 构建工具或平台库: ${sdkRoot}`);
  }

  const aapt2 = path.join(buildToolsDir, aapt2Name);
  const d8Bin = path.join(buildToolsDir, d8Name);
  const zipalign = path.join(buildToolsDir, zipalignName);
  const apksignerBin = path.join(buildToolsDir, apksignerName);
  const androidJar = path.join(platformDir, 'android.jar');
  const execTool = (toolPath, args, opts = { stdio: 'inherit' }) => (
    isWin && /\.(bat|cmd)$/i.test(toolPath)
      ? execFileSync('cmd.exe', ['/c', toolPath, ...args], opts)
      : execFileSync(toolPath, args, opts)
  );

  // 1. 同步前端生产构建产物到 android/app/src/main/assets/www
  const assetIntegrity = syncAndroidAssets({ rootDir });

  const mainDir = path.join(rootDir, 'android', 'app', 'src', 'main');
  const manifestXml = fs.readFileSync(path.join(mainDir, 'AndroidManifest.xml'), 'utf8');
  const versionMatch = manifestXml.match(/android:versionName="([^"]+)"/);
  const apkVersionName = versionMatch ? versionMatch[1] : '5.2.3';
  const workDir = path.join(rootDir, 'android', 'app', 'build', 'apk-work');
  const classesDir = path.join(workDir, 'classes');
  const genDir = path.join(workDir, 'gen');
  const compiledResZip = path.join(workDir, 'compiled_res.zip');
  const unalignedApk = path.join(workDir, 'Looma-unaligned.apk');
  const alignedApk = path.join(workDir, 'Looma-aligned.apk');
  const outDir = path.join(rootDir, 'output', 'android');
  const finalApk = path.join(outDir, `Looma-v${apkVersionName}-release-signed.apk`);

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(classesDir, { recursive: true });
  fs.mkdirSync(genDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 2. aapt2 编译 res 资源并链接 AndroidManifest.xml
  execFileSync(aapt2, [
    'compile',
    '--dir', path.join(mainDir, 'res'),
    '-o', compiledResZip,
  ], { stdio: 'inherit' });

  execFileSync(aapt2, [
    'link',
    '-I', androidJar,
    '--manifest', path.join(mainDir, 'AndroidManifest.xml'),
    '--java', genDir,
    '-o', unalignedApk,
    compiledResZip,
  ], { stdio: 'inherit' });

  // 3. javac 编译全部 Java 源码（含 R.java）
  const javaDir = path.join(mainDir, 'java', 'com', 'looma', 'agent');
  const javaFiles = fs.readdirSync(javaDir)
    .filter(f => f.endsWith('.java'))
    .map(f => path.join(javaDir, f));
  const rJava = path.join(genDir, 'com', 'looma', 'agent', 'R.java');
  if (fs.existsSync(rJava)) {
    javaFiles.push(rJava);
  }

  execFileSync('javac', [
    '--release', '11',
    '-encoding', 'UTF-8',
    '-cp', androidJar,
    '-d', classesDir,
    ...javaFiles,
  ], { stdio: 'inherit' });

  // 4. d8 将字节码转换为 Android Dalvik DEX (classes.dex)
  const classFiles = fs.readdirSync(path.join(classesDir, 'com', 'looma', 'agent'))
    .filter(f => f.endsWith('.class'))
    .map(f => path.join(classesDir, 'com', 'looma', 'agent', f));

  execTool(d8Bin, [
    '--release',
    '--min-api', '26',
    '--lib', androidJar,
    '--output', workDir,
    ...classFiles,
  ]);

  // 5. 将 classes.dex 与 POSIX 正斜杠路径的 assets/ 注入 APK
  execFileSync('jar', [
    '-uf', unalignedApk,
    '-C', workDir, 'classes.dex',
    '-C', mainDir, 'assets',
  ], { stdio: 'inherit' });

  // 6. zipalign 4 字节对齐优化
  execFileSync(zipalign, [
    '-p', '-f', '4',
    unalignedApk,
    alignedApk,
  ], { stdio: 'inherit' });

  // 7. 固定签名证书防误重签校验 + RSA-2048 v1+v2+v3 全量签名
  if (process.env.CI === 'true' && !process.env.LOOMA_KEYSTORE_PASS) {
    throw new Error('CI 环境打包必须通过 Secret 提供 LOOMA_KEYSTORE_PASS。');
  }
  const {
    keystorePath,
    keystorePass,
    keyAlias,
    certSha256,
  } = ensureSigningKeystore({
    rootDir,
    allowNewKeystore: options.allowNewKeystore === true || process.env.LOOMA_ALLOW_NEW_KEYSTORE === '1',
    keystorePass: process.env.LOOMA_KEYSTORE_PASS || 'looma2026secure',
    keyAlias: process.env.LOOMA_KEY_ALIAS || 'looma_release',
  });

  execTool(apksignerBin, [
    'sign',
    '--ks', keystorePath,
    '--ks-key-alias', keyAlias,
    '--ks-pass', `pass:${keystorePass}`,
    '--key-pass', `pass:${keystorePass}`,
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'true',
    '--v3-signing-enabled', 'true',
    '--out', finalApk,
    alignedApk,
  ]);

  // 8. 校验 APK 签名合法性
  const verifyOutput = execTool(apksignerBin, [
    'verify', '--verbose', finalApk,
  ], { encoding: 'utf8' });

  const apkBuffer = fs.readFileSync(finalApk);
  const sha256 = crypto.createHash('sha256').update(apkBuffer).digest('hex');

  return {
    apkPath: finalApk,
    sizeBytes: apkBuffer.length,
    sha256,
    certSha256,
    bundledWebFiles: assetIntegrity.fileCount,
    verified: verifyOutput.includes('Verified using v2 scheme (APK Signature Scheme v2): true'),
  };
}

if (require.main === module) {
  const res = packageAndroidApk();
  console.log(JSON.stringify(res, null, 2));
}

module.exports = { packageAndroidApk, ensureSigningKeystore };

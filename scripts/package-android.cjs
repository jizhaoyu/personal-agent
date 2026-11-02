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

function packageAndroidApk(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const sdkRoot = options.sdkRoot || process.env.ANDROID_HOME || 'D:\\DevEnv\\apps\\android-sdk';
  const buildToolsDir = findSubdirWithFile(path.join(sdkRoot, 'build-tools'), 'aapt2.exe');
  const platformDir = findSubdirWithFile(path.join(sdkRoot, 'platforms'), 'android.jar');

  if (!buildToolsDir || !platformDir) {
    throw new Error(`未找到 Android SDK 构建工具或平台库: ${sdkRoot}`);
  }

  const aapt2 = path.join(buildToolsDir, 'aapt2.exe');
  const d8Bat = path.join(buildToolsDir, 'd8.bat');
  const zipalign = path.join(buildToolsDir, 'zipalign.exe');
  const apksignerBat = path.join(buildToolsDir, 'apksigner.bat');
  const androidJar = path.join(platformDir, 'android.jar');

  // 1. 同步前端生产构建产物到 android/app/src/main/assets/www
  const assetIntegrity = syncAndroidAssets({ rootDir });

  const mainDir = path.join(rootDir, 'android', 'app', 'src', 'main');
  const workDir = path.join(rootDir, 'android', 'app', 'build', 'apk-work');
  const classesDir = path.join(workDir, 'classes');
  const genDir = path.join(workDir, 'gen');
  const compiledResZip = path.join(workDir, 'compiled_res.zip');
  const unalignedApk = path.join(workDir, 'Looma-unaligned.apk');
  const alignedApk = path.join(workDir, 'Looma-aligned.apk');
  const outDir = path.join(rootDir, 'output', 'android');
  const finalApk = path.join(outDir, 'Looma-v5.1.0-release-signed.apk');

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

  execFileSync('cmd.exe', [
    '/c', d8Bat,
    '--release',
    '--min-api', '26',
    '--lib', androidJar,
    '--output', workDir,
    ...classFiles,
  ], { stdio: 'inherit' });

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

  // 7. 生成或复用 RSA-2048 签名密钥库并执行 v1+v2+v3 全量签名
  const keystoreDir = path.join(rootDir, 'android', 'keystore');
  fs.mkdirSync(keystoreDir, { recursive: true });
  const keystorePath = path.join(keystoreDir, 'looma-release.jks');
  const keystorePass = 'looma2026secure';
  const keyAlias = 'looma_release';

  if (!fs.existsSync(keystorePath)) {
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

  execFileSync('cmd.exe', [
    '/c', apksignerBat, 'sign',
    '--ks', keystorePath,
    '--ks-key-alias', keyAlias,
    '--ks-pass', `pass:${keystorePass}`,
    '--key-pass', `pass:${keystorePass}`,
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'true',
    '--v3-signing-enabled', 'true',
    '--out', finalApk,
    alignedApk,
  ], { stdio: 'inherit' });

  // 8. 校验 APK 签名合法性
  const verifyOutput = execFileSync('cmd.exe', [
    '/c', apksignerBat, 'verify', '--verbose', finalApk,
  ], { encoding: 'utf8' });

  const apkBuffer = fs.readFileSync(finalApk);
  const sha256 = crypto.createHash('sha256').update(apkBuffer).digest('hex');

  return {
    apkPath: finalApk,
    sizeBytes: apkBuffer.length,
    sha256,
    bundledWebFiles: assetIntegrity.fileCount,
    verified: verifyOutput.includes('Verified using v2 scheme (APK Signature Scheme v2): true'),
  };
}

if (require.main === module) {
  const res = packageAndroidApk();
  console.log(JSON.stringify(res, null, 2));
}

module.exports = { packageAndroidApk };

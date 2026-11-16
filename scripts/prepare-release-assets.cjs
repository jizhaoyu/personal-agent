const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function zipPortableDirectory(sourceDir, targetZip, rootEntryName) {
  if (fs.existsSync(targetZip)) fs.unlinkSync(targetZip);
  if (process.platform === 'win32') {
    const stageParent = fs.mkdtempSync(path.join(path.dirname(targetZip), 'zip-stage-'));
    try {
      const stagedDir = path.join(stageParent, rootEntryName);
      fs.cpSync(sourceDir, stagedDir, { recursive: true });
      execFileSync('tar.exe', ['-a', '-c', '-f', targetZip, '-C', stageParent, rootEntryName], { stdio: ['ignore', 'ignore', 'inherit'] });
    } finally {
      fs.rmSync(stageParent, { recursive: true, force: true });
    }
    return;
  }
  const stageParent = fs.mkdtempSync(path.join(path.dirname(targetZip), 'zip-stage-'));
  try {
    const stagedDir = path.join(stageParent, rootEntryName);
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    execFileSync('zip', ['-r', '-q', targetZip, rootEntryName], { cwd: stageParent, stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    fs.rmSync(stageParent, { recursive: true, force: true });
  }
}

function readRecentChanges(rootDir, tag) {
  try {
    let range = '';
    if (tag) {
      try {
        const prev = execFileSync('git', ['describe', '--tags', '--abbrev=0', `${tag}^`], {
          cwd: rootDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (prev) range = `${prev}..${tag}`;
      } catch {
        range = tag;
      }
    }
    const args = range
      ? ['log', range, '--no-merges', '--max-count=15', '--pretty=format:- %s']
      : ['log', '--no-merges', '--max-count=10', '--pretty=format:- %s'];
    const raw = execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return raw || '- Routine build and maintenance updates.';
  } catch {
    return '- Routine build and maintenance updates.';
  }
}

function prepareReleaseAssets(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const tag = (options.tag || '').trim();

  const manifestXml = fs.readFileSync(path.join(rootDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const versionCodeMatch = manifestXml.match(/android:versionCode="(\d+)"/);
  const versionNameMatch = manifestXml.match(/android:versionName="([^"]+)"/);
  if (!versionCodeMatch || !versionNameMatch) {
    throw new Error('AndroidManifest.xml 缺少 versionCode 或 versionName。');
  }
  const versionCode = versionCodeMatch[1];
  const versionName = versionNameMatch[1];

  if (tag && tag !== `v${versionName}`) {
    throw new Error(`Git 标签 ${tag} 与 AndroidManifest.xml versionName (${versionName}) 不一致，请先对齐版本后再发版。`);
  }

  const buildInfo = JSON.parse(fs.readFileSync(path.join(rootDir, 'shared', 'build-info.json'), 'utf8'));
  const expectedTrialPrefix = `${versionName}-`;
  if (buildInfo.productVersion !== versionName && !String(buildInfo.productVersion || '').startsWith(expectedTrialPrefix)) {
    throw new Error(`shared/build-info.json productVersion (${buildInfo.productVersion}) 与 ${versionName} 不一致。`);
  }

  const apkName = `Looma-v${versionName}-release-signed.apk`;
  const sourceApk = path.join(rootDir, 'output', 'android', apkName);
  if (!fs.existsSync(sourceApk)) {
    throw new Error(`找不到签名 APK: ${sourceApk}`);
  }

  const desktopDir = path.join(rootDir, 'output', 'trial', `Looma-${buildInfo.buildId}-win32-x64`);
  if (!fs.existsSync(desktopDir)) {
    throw new Error(`找不到桌面打包目录: ${desktopDir}`);
  }

  const releaseDir = path.join(rootDir, 'output', 'release');
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });

  const outApk = path.join(releaseDir, apkName);
  fs.copyFileSync(sourceApk, outApk);

  const zipName = `Looma-${versionName}-win32-x64.zip`;
  const outZip = path.join(releaseDir, zipName);
  zipPortableDirectory(desktopDir, outZip, `Looma-${versionName}-win32-x64`);

  const apkSize = fs.statSync(outApk).size;
  const apkSha256 = sha256File(outApk);
  const zipSize = fs.statSync(outZip).size;
  const zipSha256 = sha256File(outZip);
  const fingerprintPath = path.join(rootDir, 'android', 'keystore.fingerprint');
  const certSha256 = fs.existsSync(fingerprintPath) ? fs.readFileSync(fingerprintPath, 'utf8').trim() : 'unknown';

  const recentChanges = readRecentChanges(rootDir, tag || `v${versionName}`);
  const displayTag = tag || `v${versionName}`;
  const notes = [
    `## Looma ${displayTag}`,
    '',
    '本地优先、零遥测的客户跟进与生活陪伴工作台（Android + Windows Desktop）。',
    'Local-first, zero-telemetry client follow-through & life companion across Android and Windows Desktop.',
    '',
    '### 变更摘要 / Changes',
    recentChanges,
    '',
    '### 升级与防丢提醒 / Upgrade & Data Safety',
    '- **Android 用户（重要）**：请**直接覆盖安装新版 APK，切勿先卸载旧版**；同签名证书构建可直接保留全部本地数据库、待办提醒与加密模型配置。建议升级前先在设置页导出备份。',
    `- **Windows 桌面便携版**：解压 \`${zipName}\` 后双击 \`Looma.exe\` 运行，原有 Windows 用户数据目录将自动保留。`,
    '',
    '### 构建元数据与校验 / Metadata & Checksums',
    `androidVersionCode: ${versionCode}`,
    `Build ID: ${buildInfo.buildId}`,
    '',
    '| 文件 / Asset | 大小 / Size | SHA-256 |',
    '| :--- | :--- | :--- |',
    `| \`${apkName}\` | ${apkSize.toLocaleString('en-US')} bytes | \`${apkSha256}\` |`,
    `| \`${zipName}\` | ${zipSize.toLocaleString('en-US')} bytes | \`${zipSha256}\` |`,
    '',
    `Android Signing Certificate SHA-256: \`${certSha256}\``,
    '',
    `${apkSha256}  ${apkName}`,
    `${zipSha256}  ${zipName}`,
    '',
  ].join('\n');

  const notesPath = path.join(releaseDir, 'release-notes.md');
  fs.writeFileSync(notesPath, notes, 'utf8');

  return {
    releaseDir,
    versionName,
    versionCode,
    apkPath: outApk,
    apkName,
    apkSize,
    apkSha256,
    zipPath: outZip,
    zipName,
    zipSize,
    zipSha256,
    certSha256,
    notesPath,
  };
}

if (require.main === module) {
  const tagIdx = process.argv.indexOf('--tag');
  const tag = tagIdx !== -1 ? process.argv[tagIdx + 1] : process.env.GITHUB_REF_NAME || '';
  const summary = prepareReleaseAssets({ tag });
  console.log(JSON.stringify(summary, null, 2));
}

module.exports = { prepareReleaseAssets };

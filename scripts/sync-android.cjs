const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function copyRecursive(srcDir, destDir, rootSrcDir = srcDir, manifest = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath, rootSrcDir, manifest);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      const rel = path.relative(rootSrcDir, srcPath).replace(/\\/g, '/');
      const content = fs.readFileSync(srcPath);
      manifest[rel] = crypto.createHash('sha256').update(content).digest('hex');
    }
  }
  return manifest;
}

function syncAndroidAssets(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const distDir = options.distDir || path.join(rootDir, 'dist');
  const assetsWwwDir = options.assetsWwwDir || path.join(rootDir, 'android', 'app', 'src', 'main', 'assets', 'www');

  if (!fs.existsSync(distDir) || !fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`前端构建产物不存在: ${distDir}，请先运行 npm run build`);
  }

  if (fs.existsSync(assetsWwwDir)) {
    fs.rmSync(assetsWwwDir, { recursive: true, force: true });
  }

  const hashes = copyRecursive(distDir, assetsWwwDir);
  const integrityPayload = {
    generatedAt: new Date().toISOString(),
    fileCount: Object.keys(hashes).length,
    algorithm: 'SHA-256',
    files: hashes,
  };
  fs.writeFileSync(
    path.join(assetsWwwDir, 'asset-hashes.json'),
    JSON.stringify(integrityPayload, null, 2),
    'utf8'
  );
  return integrityPayload;
}

if (require.main === module) {
  const result = syncAndroidAssets();
  console.log(JSON.stringify({
    status: 'SYNCED',
    target: 'android/app/src/main/assets/www',
    fileCount: result.fileCount,
    algorithm: result.algorithm,
  }, null, 2));
}

module.exports = { syncAndroidAssets };

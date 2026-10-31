const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { checkedFile, digest, runtimeInventory } = require('./trial-files.cjs');

const PRODUCT_VERSION = '5.1.0-trial';
const CHANNEL = 'internal-trial';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.js', '.cjs', '.mjs', '.json']);
function walk(directory, accept, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`构建文件不得是链接：${relative}`);
    if (entry.isDirectory()) return walk(path.join(directory, entry.name), accept, relative);
    return accept(relative) ? [relative] : [];
  });
}
function sourceFingerprint(root) {
  const hash = createHash('sha256');
  const files = ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json',
    'scripts/build-info.cjs', 'scripts/package-trial.cjs', 'scripts/trial-files.cjs'];
  for (const directory of ['src', 'electron', 'shared']) for (const name of walk(path.join(root, directory), name => SOURCE_EXTENSIONS.has(path.extname(name)) && !/(^|\/)(build-info\.json|\..*|.*(?:credentials|secret|backup).*\.(?:json|jsonl))$/i.test(name))) files.push(`${directory}/${name}`);
  for (const file of files.sort()) if (fs.existsSync(path.join(root, file))) hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  for (const file of runtimeInventory(root)) hash.update(file.source).update('\0').update(file.target).update('\0').update(file.sha256).update('\0');
  return hash.digest('hex');
}
function createBuildInfo(root, { now = new Date().toISOString() } = {}) {
  const at = new Date(now); if (!Number.isFinite(at.getTime())) throw new Error('构建时间无效。');
  const builtAt = at.toISOString();
  const stamp = builtAt.slice(0, 19).replace(/[-:]/g, '') + 'Z';
  return { productVersion: PRODUCT_VERSION, buildId: `trial-${stamp}-${sourceFingerprint(root).slice(0, 10)}`, builtAt, channel: CHANNEL };
}
function distFiles(root) {
  const manifest = JSON.parse(fs.readFileSync(checkedFile(root, 'dist/.vite/manifest.json'), 'utf8'));
  const entry = Object.keys(manifest).find(key => manifest[key]?.isEntry && manifest[key]?.src === 'index.html');
  if (!entry) throw new Error('本次 Vite 构建缺少页面入口。');
  const files = new Set(['index.html', 'build-info.json', '.vite/manifest.json']), visited = new Set();
  const asset = file => {
    if (typeof file !== 'string' || !file.startsWith('assets/') || file.includes('\\') || file.split('/').some(part => ['.', '..', ''].includes(part))) throw new Error('Vite 资源路径无效。');
    checkedFile(root, `dist/${file}`); files.add(file);
  };
  function visit(key) {
    if (visited.has(key)) return; visited.add(key);
    const chunk = manifest[key]; if (!chunk || typeof chunk !== 'object') throw new Error('Vite 构建依赖缺失。');
    asset(chunk.file);
    for (const group of ['css', 'assets']) {
      if (chunk[group] !== undefined && !Array.isArray(chunk[group])) throw new Error('Vite 资源依赖格式无效。');
      for (const file of chunk[group] || []) asset(file);
    }
    for (const group of ['imports', 'dynamicImports']) {
      if (chunk[group] !== undefined && !Array.isArray(chunk[group])) throw new Error('Vite 模块依赖格式无效。');
      for (const dependency of chunk[group] || []) visit(dependency);
    }
  }
  visit(entry);
  const orphans = walk(path.join(root, 'dist/assets'), () => true).filter(name => !files.has(`assets/${name}`));
  if (orphans.length) throw new Error(`存在不属于本次构建的孤立资源：${orphans[0]}；请重新构建。`);
  return [...files].sort((a, b) => a.localeCompare(b, 'en'));
}
function prepareDist(root) {
  const base = fs.realpathSync(root), output = path.resolve(base, 'dist');
  if (path.dirname(output) !== base || path.basename(output) !== 'dist') throw new Error('构建输出超出预期范围。');
  if (fs.existsSync(output)) {
    if (fs.lstatSync(output).isSymbolicLink() || fs.realpathSync(output) !== output) throw new Error('构建输出不能是链接或超出项目范围。');
    // Node 24 on Windows can silently leave non-ASCII paths behind with rmSync.
    // Preflight every entry before deleting anything, then use explicit operations.
    walk(output, () => true);
    function removeGenerated(directory) {
      if (!directory.startsWith(output + path.sep) && directory !== output) throw new Error('构建清理超出预期范围。');
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('构建清理不能经过链接。');
        if (entry.isDirectory()) removeGenerated(target);
        else fs.unlinkSync(target);
      }
      fs.rmdirSync(directory);
    }
    removeGenerated(output);
    if (fs.existsSync(output)) throw new Error('构建目录清理失败，未继续构建。');
  }
  fs.mkdirSync(output, { recursive: true });
  if (fs.readdirSync(output).length) throw new Error('构建目录未清空，未继续构建。');
}
function stampDist(root) {
  const info = JSON.parse(fs.readFileSync(path.join(root, 'shared/build-info.json'), 'utf8'));
  const expected = createBuildInfo(root, { now: info.builtAt });
  if (JSON.stringify(info) !== JSON.stringify(expected)) throw new Error('源码与构建标识不符，请重新构建。');
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) throw new Error('生产页面不存在，请先构建。');
  fs.writeFileSync(path.join(root, 'dist/build-info.json'), JSON.stringify(info, null, 2) + '\n');
  const files = distFiles(root).map(file => ({ file, sha256: digest(checkedFile(root, `dist/${file}`)) }));
  const manifest = { buildId: info.buildId, files, runtime: runtimeInventory(root) };
  fs.writeFileSync(path.join(root, 'dist/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  if (process.argv.includes('--stamp-dist')) { const manifest = stampDist(root); console.log(`Stamped ${manifest.buildId}: ${manifest.files.length} production files`); }
  else { const info = createBuildInfo(root); prepareDist(root); fs.mkdirSync(path.join(root, 'shared'), { recursive: true }); fs.writeFileSync(path.join(root, 'shared/build-info.json'), JSON.stringify(info, null, 2) + '\n'); console.log(info.buildId); }
}
module.exports = { createBuildInfo, sourceFingerprint, distFiles, stampDist, prepareDist };

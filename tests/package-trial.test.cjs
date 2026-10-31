const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function optionalScript(name) {
  try { return require(path.join(process.cwd(), 'scripts', name)); } catch { return {}; }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-package-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, content = file) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  for (const name of ['package.json', 'package-lock.json', 'index.html', 'src/App.tsx', 'electron/main.cjs', 'electron/preload.cjs', 'electron/desktop-services.cjs', 'electron/persistence.cjs', 'shared/persistence-core.mjs']) put(name, name.endsWith('.json') ? '{}' : name);
  put('node_modules/electron/dist/electron.exe'); put('node_modules/electron/dist/LICENSE'); put('node_modules/electron/dist/icudtl.dat'); put('node_modules/electron/dist/resources/default_app.asar'); put('node_modules/electron/dist/locales/en-US.pak');
  for (const name of ['better-sqlite3/lib/index.js', 'better-sqlite3/lib/database.js', 'better-sqlite3/build/Release/better_sqlite3.node', 'bindings/bindings.js', 'file-uri-to-path/index.js']) put(`node_modules/${name}`);
  for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) put(`node_modules/${name}/package.json`, JSON.stringify({ name, main: name === 'bindings' ? 'bindings.js' : name === 'file-uri-to-path' ? 'index.js' : 'lib/index.js' }));
  put('dist/index.html', '<script src="/assets/app.js"></script>'); put('dist/assets/app.js', 'console.log("build")');
  put('dist/.vite/manifest.json', JSON.stringify({ 'index.html': { file: 'assets/app.js', src: 'index.html', isEntry: true } }));
  for (const name of ['.env', 'credentials.json', 'looma.sqlite', 'full-backup.jsonl', 'node_modules/better-sqlite3/private-key.pem', 'electron/secret.json', 'dist/looma.sqlite', 'dist/.env', 'node_modules/electron/dist/credentials.json']) put(name, 'DO_NOT_PACKAGE');
  return { root, put };
}
test('build identity includes working source contents instead of relying on git HEAD', t => {
  const { root, put } = fixture(t); const { createBuildInfo } = optionalScript('build-info.cjs');
  assert.equal(typeof createBuildInfo, 'function');
  const now = '2026-10-29T04:00:00.000Z';
  const first = createBuildInfo(root, { now });
  assert.deepEqual(first, createBuildInfo(root, { now }));
  assert.equal(first.productVersion, '5.1.0-trial'); assert.equal(first.channel, 'internal-trial'); assert.equal(first.builtAt, now);
  put('src/App.tsx', 'changed uncommitted source');
  assert.notEqual(createBuildInfo(root, { now }).buildId, first.buildId);
  const beforeSecretChange = createBuildInfo(root, { now }).buildId;
  put('.env', 'changed-secret');
  assert.equal(createBuildInfo(root, { now }).buildId, beforeSecretChange);
});
test('portable package copies only runtime allowlisted files and never overwrites an existing build', t => {
  const { root, put } = fixture(t); const { createBuildInfo, stampDist } = optionalScript('build-info.cjs');
  const { packageTrial } = optionalScript('package-trial.cjs');
  assert.equal(typeof createBuildInfo, 'function'); assert.equal(typeof stampDist, 'function'); assert.equal(typeof packageTrial, 'function');
  put('shared/build-info.json', JSON.stringify(createBuildInfo(root, { now: '2026-10-29T04:00:00.000Z' })));
  stampDist(root);
  const result = packageTrial(root, { outputRoot: path.join(root, 'out') });
  assert.equal(fs.existsSync(path.join(result.directory, 'Looma.exe')), true);
  assert.equal(fs.existsSync(path.join(result.directory, 'resources/app/electron/main.cjs')), true);
  assert.equal(fs.existsSync(path.join(result.directory, 'resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node')), true);
  const files = fs.readdirSync(result.directory, { recursive: true }).filter(name => fs.statSync(path.join(result.directory, name)).isFile());
  for (const forbidden of ['.env', 'credentials.json', 'looma.sqlite', 'full-backup.jsonl', 'private-key.pem', 'secret.json', 'default_app.asar']) assert.ok(!files.some(name => name.split(path.sep).at(-1) === forbidden), forbidden);
  assert.equal(files.some(name => name.endsWith('package-lock.json')), false);
  const packaged = JSON.parse(fs.readFileSync(path.join(result.directory, 'resources/app/package.json'), 'utf8'));
  assert.equal(packaged.main, 'electron/main.cjs'); assert.equal(packaged.version, '5.1.0-trial'); assert.equal(packaged.scripts, undefined);
  assert.match(fs.readFileSync(path.join(result.directory, '试用前请读.txt'), 'utf8'), /安全发布门槛尚未完成/);
  assert.throws(() => packageTrial(root, { outputRoot: path.join(root, 'out') }), /已存在/);
});
test('packaging rejects a stale production build after source changes', t => {
  const { root, put } = fixture(t); const { createBuildInfo, stampDist } = optionalScript('build-info.cjs'); const { packageTrial } = optionalScript('package-trial.cjs');
  assert.equal(typeof packageTrial, 'function');
  put('shared/build-info.json', JSON.stringify(createBuildInfo(root, { now: '2026-10-29T04:00:00.000Z' }))); stampDist(root);
  put('src/App.tsx', 'changed after production build');
  assert.throws(() => packageTrial(root, { outputRoot: path.join(root, 'out') }), /源码.*构建|重新构建/);
});
test('stamping refuses an orphaned asset that is not reachable from this Vite build', t => {
  const { root, put } = fixture(t); const { createBuildInfo, stampDist } = optionalScript('build-info.cjs');
  put('shared/build-info.json', JSON.stringify(createBuildInfo(root, { now: '2026-10-29T04:00:00.000Z' })));
  put('dist/assets/orphan.js', 'stale prior build');
  assert.throws(() => stampDist(root), /孤立|未被.*引用|不属于本次/);
});

test('packaging rejects a changed runtime inventory and copies the stamped inventory exactly', t => {
  const { root, put } = fixture(t); const { createBuildInfo, stampDist } = optionalScript('build-info.cjs');
  const { packageTrial } = optionalScript('package-trial.cjs');
  put('shared/build-info.json', JSON.stringify(createBuildInfo(root, { now: '2026-10-29T04:00:00.000Z' })));
  const manifest = stampDist(root);
  put('dist/build-manifest.json', JSON.stringify({ ...manifest, runtime: manifest.runtime.slice(1) }));
  assert.throws(() => packageTrial(root, { outputRoot: path.join(root, 'out') }), /运行依赖清单.*重新构建/);
  put('dist/build-manifest.json', JSON.stringify(manifest));
  const result = packageTrial(root, { outputRoot: path.join(root, 'out') });
  const { digest } = optionalScript('trial-files.cjs');
  for (const row of manifest.runtime) assert.equal(digest(path.join(result.directory, row.target)), row.sha256, row.target);
});
for (const runtimeFile of ['node_modules/better-sqlite3/lib/database.js', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'node_modules/electron/dist/electron.exe']) {
  test(`stamped build rejects changed runtime bytes: ${runtimeFile}`, t => {
    const { root, put } = fixture(t); const { createBuildInfo, stampDist } = optionalScript('build-info.cjs'); const { packageTrial } = optionalScript('package-trial.cjs');
    const now = '2026-10-29T04:00:00.000Z'; const original = createBuildInfo(root, { now });
    put('shared/build-info.json', JSON.stringify(original)); stampDist(root);
    put(runtimeFile, 'changed runtime bytes after stamping');
    assert.throws(() => packageTrial(root, { outputRoot: path.join(root, 'out') }), /运行|重新构建/);
    assert.notEqual(createBuildInfo(root, { now }).buildId, original.buildId);
  });
}
test('preparing a build clears only the exact generated dist directory', t => {
  const { root, put } = fixture(t); const { prepareDist } = optionalScript('build-info.cjs');
  assert.equal(typeof prepareDist, 'function');
  put('output/keep.txt', 'independent output'); prepareDist(root);
  assert.deepEqual(fs.readdirSync(path.join(root, 'dist')), []);
  assert.equal(fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8'), 'src/App.tsx');
  assert.equal(fs.readFileSync(path.join(root, 'output/keep.txt'), 'utf8'), 'independent output');
});
test('preparing a build refuses a dist junction and preserves its external target', t => {
  const { root } = fixture(t); const { prepareDist } = optionalScript('build-info.cjs');
  assert.equal(typeof prepareDist, 'function');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-package-external-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'must remain');
  fs.renameSync(path.join(root, 'dist'), path.join(root, 'old-dist'));
  fs.symlinkSync(outside, path.join(root, 'dist'), 'junction');
  assert.throws(() => prepareDist(root), /链接|范围/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'must remain');
});

test('preparing a build really removes stale resources when the project path contains Chinese', t => {
  const { root, put } = fixture(t); const { prepareDist } = optionalScript('build-info.cjs');
  const project = path.join(root, '中文项目');
  put('中文项目/dist/assets/stale.js', 'previous generated asset');
  put('中文项目/src/keep.ts', 'source must remain');
  prepareDist(project);
  assert.deepEqual(fs.readdirSync(path.join(project, 'dist')), []);
  assert.equal(fs.readFileSync(path.join(project, 'src/keep.ts'), 'utf8'), 'source must remain');
});

test('preparing a build rejects a nested junction before deleting any generated files', t => {
  const { root, put } = fixture(t); const { prepareDist } = optionalScript('build-info.cjs');
  put('outside/keep.txt', 'external data must remain');
  put('dist/a-before-link.js', 'generated file must remain after preflight rejection');
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'dist/assets/linked'), 'junction');
  assert.throws(() => prepareDist(root), /链接/);
  assert.equal(fs.readFileSync(path.join(root, 'outside/keep.txt'), 'utf8'), 'external data must remain');
  assert.equal(fs.existsSync(path.join(root, 'dist/a-before-link.js')), true);
});

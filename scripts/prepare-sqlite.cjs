const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const electron = require('electron');
const probe = () => spawnSync(electron, [path.join(__dirname, 'check-sqlite.cjs')], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8' });
let result = probe();
if (result.status !== 0) {
  const version = require('electron/package.json').version;
  const modulePath = path.dirname(require.resolve('better-sqlite3/package.json'));
  const bin = require.resolve('prebuild-install/bin.js');
  const download = spawnSync(process.execPath, [bin, '--runtime=electron', `--target=${version}`, `--arch=${process.arch}`], { cwd: modulePath, windowsHide: true, stdio: 'inherit' });
  if (download.status !== 0) {
    console.error('SQLite原生模块未准备好。保留原有数据，请检查Electron预构建下载后重试 npm run prepare:sqlite。');
    process.exit(1);
  }
  result = probe();
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.status !== 0) { console.error('SQLite与当前Electron不兼容，未启动数据迁移。'); if (result.stderr) process.stderr.write(result.stderr); }
process.exitCode = result.status ?? 1;

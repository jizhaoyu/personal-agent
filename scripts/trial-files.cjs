const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ELECTRON_FILES = ['electron.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'LICENSE', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version', 'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll'];
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function checkedFile(root, relative) {
  const base = fs.realpathSync(root), absolute = path.resolve(base, relative);
  if (!absolute.startsWith(base + path.sep) || fs.lstatSync(absolute).isSymbolicLink() || !fs.statSync(absolute).isFile()) throw new Error(`运行文件路径或链接无效：${relative}`);
  const real = fs.realpathSync(absolute);
  if (!real.startsWith(base + path.sep)) throw new Error(`运行文件超出项目范围：${relative}`);
  return absolute;
}
/** This exact allowlist drives both the build identity and the bytes copied into a package. */
function runtimeFiles(root) {
  const files = [];
  const add = (source, target) => { checkedFile(root, source); files.push({ source, target }); };
  const optional = (source, target) => { if (fs.existsSync(path.join(root, source))) add(source, target); };
  for (const required of ['electron.exe', 'LICENSE', 'icudtl.dat']) if (!fs.existsSync(path.join(root, 'node_modules/electron/dist', required))) throw new Error('Windows Electron 运行时不完整。');
  for (const file of ELECTRON_FILES) optional(`node_modules/electron/dist/${file}`, file === 'electron.exe' ? 'Looma.exe' : file);
  const locales = path.join(root, 'node_modules/electron/dist/locales');
  if (fs.existsSync(locales)) for (const file of fs.readdirSync(locales).filter(name => name.endsWith('.pak'))) add(`node_modules/electron/dist/locales/${file}`, `locales/${file}`);
  for (const file of ['better-sqlite3/package.json', 'better-sqlite3/build/Release/better_sqlite3.node', 'bindings/package.json', 'bindings/bindings.js', 'file-uri-to-path/package.json', 'file-uri-to-path/index.js']) add(`node_modules/${file}`, `resources/app/node_modules/${file}`);
  function library(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`运行依赖不得是链接：${name}`);
      if (entry.isDirectory()) library(name);
      else if (entry.name.endsWith('.js')) add(name, `resources/app/${name}`);
    }
  }
  checkedFile(root, 'node_modules/better-sqlite3/lib/index.js'); library('node_modules/better-sqlite3/lib');
  for (const module of ['better-sqlite3', 'bindings', 'file-uri-to-path']) for (const license of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) optional(`node_modules/${module}/${license}`, `resources/app/node_modules/${module}/${license}`);
  return files.sort((a, b) => a.source.localeCompare(b.source, 'en'));
}
function runtimeInventory(root) { return runtimeFiles(root).map(file => ({ ...file, sha256: digest(checkedFile(root, file.source)) })); }
module.exports = { checkedFile, digest, runtimeFiles, runtimeInventory };

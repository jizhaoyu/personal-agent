const fs = require('node:fs');
const path = require('node:path');
const { createBuildInfo, distFiles } = require('./build-info.cjs');
const { checkedFile, digest, runtimeInventory } = require('./trial-files.cjs');

function copyFile(root, source, target) {
  const from = checkedFile(root, source);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(from, target);
}
function packageTrial(root, { outputRoot = path.join(root, 'output/trial') } = {}) {
  const info = JSON.parse(fs.readFileSync(path.join(root, 'shared/build-info.json'), 'utf8'));
  if (JSON.stringify(info) !== JSON.stringify(createBuildInfo(root, { now: info.builtAt }))) throw new Error('源码与生产构建不一致，请重新构建。');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-manifest.json'), 'utf8'));
  const files = distFiles(root);
  if (manifest.buildId !== info.buildId || JSON.stringify(manifest.files.map(row => row.file)) !== JSON.stringify(files)) throw new Error('生产构建清单不一致，请重新构建。');
  for (const row of manifest.files) if (digest(checkedFile(root, `dist/${row.file}`)) !== row.sha256) throw new Error('生产资源已改变，请重新构建。');
  const runtime = runtimeInventory(root);
  if (JSON.stringify(manifest.runtime) !== JSON.stringify(runtime)) throw new Error('运行依赖清单不一致，请重新构建。');
  const directory = path.resolve(outputRoot, `Looma-${info.buildId}-win32-x64`);
  if (fs.existsSync(directory)) throw new Error('该构建目录已存在，未覆盖；请保留原包或重新生成构建。');
  const required = ['electron/main.cjs', 'electron/preload.cjs', 'electron/desktop-services.cjs', 'electron/persistence.cjs', 'shared/persistence-core.mjs', 'shared/build-info.json'];
  for (const name of required) if (!fs.existsSync(path.join(root, name))) throw new Error(`运行依赖缺失：${name}`);
  fs.mkdirSync(directory, { recursive: true });
  for (const row of runtime) {
    const target = path.join(directory, row.target);
    copyFile(root, row.source, target);
    if (digest(target) !== row.sha256) throw new Error('复制后的运行依赖内容不一致，请重新构建。');
  }
  const app = path.join(directory, 'resources/app');
  for (const name of required) copyFile(root, name, path.join(app, name));
  for (const name of [...files, 'build-manifest.json']) copyFile(root, `dist/${name}`, path.join(app, 'dist', name));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'looma-internal-trial', productName: 'Looma', version: info.productVersion, description: 'Looma internal local trial', main: 'electron/main.cjs', type: 'module', license: 'MIT' }, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'release-status.json'), JSON.stringify({ buildId: info.buildId, channel: info.channel, publicDistributionApproved: false, blockers: ['Existing Electron dependency security release gate is not yet complete.', 'Unsigned local verification build; clean-machine distribution acceptance remains pending.'] }, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, '试用前请读.txt'), `Looma ${info.productVersion}\r\n构建号：${info.buildId}\r\n\r\n这是供负责人本地验证的独立启动包。安全发布门槛尚未完成，未签名，不作为可安全公开分发的安装包。\r\n保留整个目录，双击 Looma.exe；目标机器不需要安装 Node.js 或 npm，也不需要运行构建命令。\r\n当前保留原有 Electron 运行时，未执行依赖大版本升级。对外试用及录入真实客户资料前，请负责人完成已记录的依赖安全升级与回归。\r\n此包没有包含项目用户资料、模型凭据、备份、测试原文或开发环境。使用后业务资料会保存在 Windows 用户应用资料目录；应用文件夹与业务资料分别保存。\r\n退出后不提醒；胶囊状态仍属于应用开启。模型增强可选，基础整理无需配置 Key。\r\n反馈时提供构建号和操作步骤；请勿直接发送客户原文、数据库、API Key 或内部备注。\r\n`);
  fs.appendFileSync(path.join(directory, '试用前请读.txt'), '\r\n便携包使用独立应用名称，其默认资料目录可能与源码启动版不同。旧资料仍在原目录；需要迁移时，请从原版完整备份，再在本版审阅导入，不会自动合并或搬移。\r\n构建清单的SHA256用于核对本地构建内容，不是数字签名，也不能证明安装来源可信。\r\n');
  return { directory, executable: path.join(directory, 'Looma.exe'), buildInfo: info, productionFiles: files.length };
}
if (require.main === module) {
  try { console.log(JSON.stringify(packageTrial(path.resolve(__dirname, '..')), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { packageTrial };

// Optional real packaged-runtime check. Playwright is supplied outside application dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
async function main() {
  const root = path.resolve(__dirname, '..');
  const packageRoot = process.env.LOOMA_TRIAL_DIRECTORY ? path.resolve(process.env.LOOMA_TRIAL_DIRECTORY) : (() => {
    const parent = path.join(root, 'output/trial');
    return fs.readdirSync(parent).filter(name => name.startsWith('Looma-trial-')).map(name => path.join(parent, name)).sort().at(-1);
  })();
  assert.ok(packageRoot, 'No local trial package; run npm run package:trial first');
  const executable = path.join(packageRoot, 'Looma.exe'); assert.ok(fs.existsSync(executable));
  const info = JSON.parse(fs.readFileSync(path.join(packageRoot, 'build-info.json'), 'utf8'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-packaged-qa-'));
  const dataDirectory = path.join(profile, 'user-data');
  const env = { ...process.env, NODE_ENV: 'production', PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath: executable, args: [`--user-data-dir=${dataDirectory}`], env, timeout: 20000 });
  let app; let passed = false; const checks = {};
  try {
    app = await launch(); const page = await app.firstWindow(); page.setDefaultTimeout(12000);
    await page.getByLabel('客户沟通记录', { exact: true }).waitFor();
    assert.match(page.url(), /^file:/);
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getAppPath())), path.resolve(packageRoot, 'resources/app'));
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(dataDirectory));
    assert.equal(await app.evaluate(() => process.env.PATH.toLowerCase().includes('node')), false);
    checks.actualPackagedEntryWithRestrictedPath = true;
    await page.getByLabel('客户沟通记录', { exact: true }).fill('李总预算300元，我周五发原型，客户下周一补素材，新增费用未定。');
    await page.getByRole('button', { name: '整理并核对', exact: true }).click();
    await page.getByLabel('预算 1', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^(确认并保存|确认收尾)$/ }).click();
    await page.getByRole('region', { name: '本次沟通收尾记录', exact: true }).waitFor();
    const counts = await page.evaluate(async () => (await window.electronAPI.storeRequest({ op: 'stats', space: 'work' })).counts);
    assert.equal(counts.engagement, 1); assert.equal(counts.closure, 1); assert.equal(counts.task, 1); assert.ok(counts.followup >= 1);
    assert.ok(fs.existsSync(path.join(dataDirectory, 'looma.sqlite'))); checks.packagedNativeSqliteAndCapture = true;
    const backup = path.join(profile, 'synthetic-backup.jsonl');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, backup);
    await page.evaluate(() => window.electronAPI.exportDataBackup());
    assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8').split('\n')[0]).version, 5); checks.packagedBackup = true;
    await app.close(); app = null;
    app = await launch(); const reopened = await app.firstWindow();
    await reopened.getByRole('navigation', { name: '工作台导航', exact: true }).waitFor();
    const restored = await reopened.evaluate(async () => (await window.electronAPI.storeRequest({ op: 'stats', space: 'work' })).counts);
    assert.equal(restored.engagement, 1); assert.equal(restored.closure, 1); checks.packagedRestartRestoresRecords = true;
    const marker = JSON.parse(fs.readFileSync(path.join(packageRoot, 'release-status.json'), 'utf8'));
    assert.equal(marker.publicDistributionApproved, false); checks.publicReleaseGateRemainsExplicit = true;
    fs.mkdirSync(path.join(root, 'output/playwright'), { recursive: true });
    await reopened.screenshot({ path: path.join(root, 'output/playwright/looma-packaged-trial.png') });
    const result = { buildInfo: info, checks, limitations: ['Verified on the existing development Windows host with a restricted PATH, not a separate clean Windows installation.', 'The runtime is unsigned and its existing security upgrade gate remains unresolved.'] };
    fs.writeFileSync(path.join(root, 'output/playwright/package-trial-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2)); passed = true;
  } finally {
    if (app) await app.close();
    const target = path.resolve(profile);
    if (passed && path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('looma-packaged-qa-')) fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    else console.log(`Retained synthetic verification profile: ${profile}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

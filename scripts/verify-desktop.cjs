// Optional real-Electron smoke test. Uses a separately supplied Playwright runtime,
// a temporary user profile, a loopback test provider and a synthetic test key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { _electron } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-desktop-qa-'));
  const dataDir = path.join(profile, 'profile'); fs.mkdirSync(dataDir);
  const bootstrap = path.join(profile, 'bootstrap.cjs');
  fs.writeFileSync(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(dataDir)});app.on('browser-window-created',(_e,w)=>w.hide());require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});`);
  const syntheticKey = 'looma-synthetic-qa-key';
  let lastPayload;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      lastPayload = JSON.parse(body);
      const content = JSON.stringify({ engagements: [{ clientName: '李总', title: '网站改版', budgetAmount: 300, stage: '初步接触', nextAction: '发送原型', shareableSummary: '讨论网站改版范围' }], tasks: [{ title: '发送原型', dueAt: '2020-01-01T01:00:00.000Z', sourceDeadlineText: '2020年1月1日' }], warnings: ['这是本机受控服务，仅验证管线，不评估模型准确率。'] });
      const reply = lastPayload.messages[0].content.includes('只读回忆') ? '当前预算为300元，来自项目记录。' : content;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { ...process.env, NODE_ENV: 'production' }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  let passed = false;
  const launch = () => _electron.launch({ executablePath: require('electron'), args: [bootstrap], env, timeout: 20000 });
  const result = {};
  try {
    app = await launch();
    const page = await app.firstWindow();
    await page.getByRole('textbox', { name: '客户沟通记录', exact: true }).waitFor();
    assert.match(page.url(), /^file:/); result.productionUsesLocalBuild = true;
    const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(path.resolve(actualProfile), path.resolve(dataDir));
    const status = await page.evaluate(async config => window.electronAPI.saveModelConnection(config), { apiKey: syntheticKey, apiBaseUrl: endpoint, modelName: 'controlled-test-provider', enabled: true });
    assert.equal(Object.hasOwn(status, 'apiKey'), false);
    assert.equal(status.configured, true);
    result.osEncryptionPersistent = status.persistent;
    if (status.persistent) {
      const disk = fs.readFileSync(path.join(dataDir, 'looma-model-connection.json'), 'utf8');
      assert.equal(disk.includes(syntheticKey), false); result.keyAbsentFromDiskPlaintext = true;
      await page.evaluate(() => localStorage.setItem('looma_settings', JSON.stringify({ apiKey: 'looma-synthetic-legacy-key', apiBaseUrl: 'https://legacy.example.com/v1', modelName: 'legacy-test' })));
      await page.reload();
      await page.waitForFunction(() => { const raw = localStorage.getItem('looma_settings'); return !raw || !JSON.parse(raw).apiKey; });
      const legacyArchive = fs.readFileSync(path.join(dataDir, 'looma-legacy-connection.json'), 'utf8');
      assert.equal(legacyArchive.includes('looma-synthetic-legacy-key'), false);
      const unchanged = await page.evaluate(() => window.electronAPI.modelStatus());
      assert.equal(unchanged.apiBaseUrl, endpoint);
      assert.equal(unchanged.enabled, true);
      result.legacyKeyMigratedWithoutReplacingCurrentConnection = true;
    }
    await page.reload();
    await page.getByText('桌面模型增强', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '客户沟通记录', exact: true }).fill('李总的网站改版预算300元，我2020年1月1日发原型，客户下周一补素材，新增页面费用未定。');
    await page.getByRole('button', { name: '整理并核对', exact: true }).click();
    await page.getByText('这是本机受控服务，仅验证管线，不评估模型准确率。', { exact: true }).waitFor();
    const before = await page.evaluate(async () => (await window.electronAPI.storeRequest({ op: 'bootstrap', space: 'work' })).snapshot.partitions.work.engagements.length);
    assert.equal(before, 0); result.modelDidNotWriteBeforeConfirmation = true;
    assert.equal(lastPayload.messages.length, 2);
    const input = JSON.parse(lastPayload.messages[1].content);
    assert.deepEqual(Object.keys(input).sort(), ['currentTime', 'input', 'selectedProject']);
    assert.equal(input.selectedProject, null); result.requestContextIsMinimal = true;
    await page.getByRole('button', { name: '确认并保存', exact: true }).click();
    await page.getByRole('region', { name: '本次沟通收尾记录', exact: true }).waitFor();
    const saved = await page.evaluate(async () => (await window.electronAPI.storeRequest({ op: 'bootstrap', space: 'work' })).snapshot);
    assert.equal(saved.partitions.work.engagements[0].budgetAmount, 300);
    assert.equal(saved.partitions.work.tasks.length, 1);
    assert.equal(saved.schemaVersion, 5);
    assert.equal(saved.partitions.work.followUps.length, 2);
    assert.equal(saved.partitions.work.closures.length, 1);
    const waiting = saved.partitions.work.followUps.find(item => item.kind === 'waiting');
    assert.ok(waiting.expectedDate); assert.equal(waiting.expectedAt, undefined); assert.equal(waiting.reviewAt, undefined);
    for (const section of ['已核对内容', '我方下一步', '等待客户', '仍待确认']) {
      assert.ok(await page.getByRole('region', { name: '本次沟通收尾记录', exact: true }).getByRole('region', { name: section, exact: true }).isVisible());
    }
    result.v5ClosureSeparatesResponsibilitiesAndDateGranularity = true;
    assert.equal(JSON.stringify(saved).includes(syntheticKey), false);
    result.modelConfirmedBatchSaved = true; result.backupExcludesCredential = true;
    assert.equal(fs.existsSync(path.join(dataDir, 'looma.sqlite')), true); result.sqliteFileCreated = true;
    const expanded = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    await page.locator('.app-header').getByRole('button', { name: '收起为伴侣胶囊', exact: true }).click();
    await page.locator('.capsule-shell').waitFor();
    const capsule = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.equal(capsule.width, 220); assert.equal(capsule.height, 96);
    assert.doesNotMatch(await page.locator('body').innerText(), /李总|预算|原型/);
    await page.getByRole('button', { name: /展开/ }).click();
    await page.getByRole('region', { name: '本次沟通收尾记录', exact: true }).waitFor();
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), expanded);
    result.sameWindowCapsuleAndRestore = true;
    await page.getByRole('navigation', { name: '工作台导航', exact: true }).getByRole('button', { name: '接着处理', exact: true }).click();
    await page.getByRole('region', { name: '早前安排', exact: true }).waitFor(); result.inAppDueSummary = true;
    result.nativeNotificationApi = await page.evaluate(() => window.electronAPI.notifyDue({ count: 1 }));
    await fs.promises.mkdir(path.join(root, 'output/playwright'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output/playwright/looma-electron.png') });
    // A controlled negative renderer acknowledgement exercises the native return path.
    // This simulates a failed flush response, rather than pretending to fail the real disk.
    await app.evaluate(({ dialog }) => {
      globalThis.loomaQaCloseDialogs = [];
      dialog.showMessageBox = async (_window, options) => {
        globalThis.loomaQaCloseDialogs.push({ defaultId: options.defaultId, cancelId: options.cancelId, buttons: options.buttons });
        return { response: 0 };
      };
    });
    await page.evaluate(() => {
      window.loomaQaRejectClose = window.electronAPI.onBeforeClose(requestId => { void window.electronAPI.confirmClose(false, requestId); });
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await app.evaluate(() => globalThis.loomaQaCloseDialogs.length > 0)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const closeDialog = await app.evaluate(() => globalThis.loomaQaCloseDialogs[0]);
    assert.equal(closeDialog.defaultId, 0); assert.equal(closeDialog.cancelId, 0); assert.equal(page.isClosed(), false);
    result.controlledNegativeCloseAcknowledgementReturnsToApp = true;
    await page.evaluate(() => { window.loomaQaRejectClose(); delete window.loomaQaRejectClose; });
    // Reload registers only the real React close listener again after removing the QA listener.
    await page.reload();
    await page.getByRole('navigation', { name: '工作台导航', exact: true }).waitFor();
    await page.getByRole('navigation', { name: '工作台导航', exact: true }).getByRole('button', { name: '随口记录', exact: true }).click();
    const interruptedText = '退出前刚输入的草稿：下次核对客户素材，不提交业务。';
    await page.getByRole('textbox', { name: '客户沟通记录', exact: true }).fill(interruptedText);
    const editFinishedAt = Date.now();
    const exit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Normal window close did not exit after saving')), 10000);
      app.process().once('exit', () => { clearTimeout(timer); resolve(); });
    });
    const closeRequestedAt = await app.evaluate(({ BrowserWindow }) => { const at = Date.now(); BrowserWindow.getAllWindows()[0].close(); return at; });
    assert.ok(closeRequestedAt - editFinishedAt < 500, 'normal close was requested before the autosave debounce');
    await exit; app = null;
    result.normalCloseFlushDelayMs = closeRequestedAt - editFinishedAt;
    app = await launch(); const reopened = await app.firstWindow();
    await reopened.getByRole('button', { name: '继续整理', exact: false }).click();
    assert.equal(await reopened.getByRole('textbox', { name: '客户沟通记录', exact: true }).inputValue(), interruptedText);
    result.normalCloseFlushesDraftBeforeDebounceAndRestartRestoresIt = true;
    const reopenedCount = await reopened.evaluate(async () => (await window.electronAPI.storeRequest({ op: 'stats', space: 'work' })).counts.engagement);
    assert.equal(reopenedCount, 1); result.restartRestoresBusinessData = true;
    const restoredStatus = await reopened.evaluate(() => window.electronAPI.modelStatus());
    if (status.persistent) assert.equal(restoredStatus.configured, true);
    result.restartRestoresSecureConnection = status.persistent && restoredStatus.configured;
    const backupPath = path.join(profile, 'full-backup.jsonl');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, backupPath);
    await reopened.evaluate(() => window.electronAPI.exportDataBackup());
    const backupHeader = JSON.parse(fs.readFileSync(backupPath, 'utf8').split('\n')[0]);
    assert.equal(backupHeader.format, 'looma-archive'); assert.equal(backupHeader.version, 5);
    assert.equal(fs.readFileSync(backupPath, 'utf8').includes(syntheticKey), false);
    result.nativeBackupDialogAndStream = true;
    const recallRequest = { requestId: 'recall-with-consent', query: '李总预算', space: 'work', evidence: [{ id: saved.partitions.work.engagements[0].id, kind: 'current', text: '李总当前预算300元', internalContext: 'must-not-send' }] };
    await assert.rejects(() => reopened.evaluate(value => window.electronAPI.recallModel(value), recallRequest), /授权/);
    await reopened.evaluate(() => window.electronAPI.storeRequest({ op: 'settings', patch: { memoryModelEnabled: true } }));
    const recallReply = await reopened.evaluate(value => window.electronAPI.recallModel(value), recallRequest);
    assert.match(recallReply.content, /300/);
    assert.equal(JSON.stringify(lastPayload).includes('must-not-send'), false);
    result.separateRecallConsentAndBoundedPayload = true;
    await app.close(); app = null;
    const corruptBytes = Buffer.from('synthetic corrupt sqlite for recovery QA');
    fs.writeFileSync(path.join(dataDir, 'looma.sqlite'), corruptBytes);
    const invalidPath = path.join(profile, 'invalid.jsonl'); fs.writeFileSync(invalidPath, '{"broken":true}');
    app = await launch(); const recovery = await app.firstWindow();
    await recovery.getByRole('heading', { name: '暂时无法打开工作区', exact: true }).waitFor();
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, invalidPath);
    await assert.rejects(() => recovery.evaluate(() => window.electronAPI.importDataBackup()), /恢复失败|校验失败/);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'looma.sqlite')), corruptBytes);
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, backupPath);
    await recovery.evaluate(() => window.electronAPI.importDataBackup()); await recovery.reload();
    await recovery.getByRole('button', { name: '继续整理', exact: false }).click();
    assert.equal(await recovery.getByRole('textbox', { name: '客户沟通记录', exact: true }).inputValue(), interruptedText);
    assert.equal((await recovery.evaluate(() => window.electronAPI.storeRequest({ op: 'stats', space: 'work' }))).counts.engagement, 1);
    assert.ok(fs.readdirSync(dataDir).some(name => name.startsWith('looma.sqlite.unreadable-')));
    result.corruptSqliteValidatesBackupBeforePreservingAndRestoring = true;
    fs.writeFileSync(path.join(root, 'output/playwright/desktop-v5-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    passed = true;
  } finally {
    if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const resolvedProfile = path.resolve(profile);
    if (passed && path.dirname(resolvedProfile) === path.resolve(os.tmpdir()) && path.basename(resolvedProfile).startsWith('looma-desktop-qa-')) {
      fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 3 });
    } else console.log(`Retained QA profile for diagnosis: ${profile}`);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

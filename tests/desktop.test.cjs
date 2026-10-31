const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

// The optional load makes the missing feature an assertion failure in the RED run.
let desktop = {};
try { desktop = require('../electron/desktop-services.cjs'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-desktop-test-'));
  t.after(() => {
    if (!directory.startsWith(path.join(os.tmpdir(), 'looma-desktop-test-'))) throw new Error('Unsafe test cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => value.toString().replace(/^encrypted:/, ''),
  };
  assert.equal(typeof desktop.createDesktopServices, 'function', 'desktop service factory is available');
  const service = desktop.createDesktopServices({
    userDataPath: directory, safeStorage, fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ engagements: [], tasks: [], warnings: [] }) } }] }),
    }), ...overrides,
  });
  return { service, directory };
}

const connection = { apiBaseUrl: 'https://api.example.test/v1', modelName: 'test-model', enabled: true, apiKey: 'test-only-key' };
const request = { requestId: 'test-request', text: '李总预算300元', context: null, now: '2026-10-26T10:00:00+08:00' };

test('production mode loads the local build even when the app is unpackaged', () => {
  assert.equal(typeof desktop.getWindowTarget, 'function');
  assert.equal(desktop.getWindowTarget({ nodeEnv: 'production', isPackaged: false, indexPath: 'D:/app/dist/index.html' }).type, 'file');
  assert.equal(desktop.getWindowTarget({ nodeEnv: 'development', isPackaged: false, indexPath: 'D:/app/dist/index.html' }).type, 'url');
  assert.equal(desktop.getWindowTarget({ nodeEnv: undefined, isPackaged: true, indexPath: 'D:/app/dist/index.html' }).type, 'file');
});

test('API endpoint permits HTTPS or loopback HTTP and rejects credential or redirect bait', () => {
  assert.equal(typeof desktop.validateEndpoint, 'function');
  assert.equal(desktop.validateEndpoint('https://api.example.test/v1/'), 'https://api.example.test/v1');
  assert.equal(desktop.validateEndpoint('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(desktop.validateEndpoint('http://[::1]:11434/v1'), 'http://[::1]:11434/v1');
  for (const url of ['http://example.com/v1', 'https://secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret', 'file:///tmp/api', 'https://example.com\\@evil.test/v1']) {
    assert.throws(() => desktop.validateEndpoint(url));
  }
});

test('IPC only accepts the expected window main frame at the exact app URL', () => {
  assert.equal(typeof desktop.isTrustedSender, 'function');
  const mainFrame = { url: 'http://localhost:5173/' };
  const contents = { mainFrame };
  const trusted = { sender: contents, senderFrame: mainFrame };
  assert.equal(desktop.isTrustedSender(trusted, contents, 'http://localhost:5173/'), true);
  assert.equal(desktop.isTrustedSender({ ...trusted, senderFrame: { url: mainFrame.url } }, contents, mainFrame.url), false);
  assert.equal(desktop.isTrustedSender({ ...trusted, sender: {} }, contents, mainFrame.url), false);
  assert.equal(desktop.isTrustedSender(trusted, contents, 'http://localhost:5173/other'), false);
});

test('credentials are encrypted on disk and status never returns the key', async t => {
  const { service, directory } = fixture(t);
  const status = await service.saveModelConnection(connection);
  assert.equal(status.configured, true);
  assert.equal(status.persistent, true);
  assert.equal(status.enabled, true);
  assert.equal('apiKey' in status, false);
  const disk = fs.readFileSync(path.join(directory, 'looma-model-connection.json'), 'utf8');
  assert.equal(disk.includes(connection.apiKey), false);
  assert.equal(typeof JSON.parse(disk).encryptedKey, 'string');
  const reloaded = desktop.createDesktopServices({ userDataPath: directory, safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: value => value.toString().replace(/^encrypted:/, ''),
    encryptString: value => Buffer.from(`encrypted:${value}`),
  } });
  assert.equal((await reloaded.modelStatus()).configured, true);
  await service.clearModelConnection();
  assert.equal((await service.modelStatus()).configured, false);
  assert.equal(fs.existsSync(path.join(directory, 'looma-model-connection.json')), false);
});

test('unavailable OS encryption keeps a new key in memory only', async t => {
  const { service, directory } = fixture(t, { safeStorage: { isEncryptionAvailable: () => false } });
  const status = await service.saveModelConnection(connection);
  assert.equal(status.configured, true);
  assert.equal(status.persistent, false);
  assert.equal(fs.existsSync(path.join(directory, 'looma-model-connection.json')), false);
});

test('Ollama can be configured without a fabricated API key', async t => {
  const { service } = fixture(t);
  const status = await service.saveModelConnection({ apiBaseUrl: 'http://127.0.0.1:11434/v1', modelName: 'local-model', enabled: true });
  assert.equal(status.configured, true);
});

const legacyConnection = { apiBaseUrl: 'https://legacy.example.test/v1', modelName: 'legacy-model', apiKey: 'legacy-test-only-key' };

test('legacy credentials migrate to an inactive native connection when none is configured', async t => {
  const { service, directory } = fixture(t);
  assert.equal(typeof service.migrateLegacyConnection, 'function');
  assert.deepEqual(await service.migrateLegacyConnection(legacyConnection), { migrated: true });
  const status = await service.modelStatus();
  assert.equal(status.configured, true);
  assert.equal(status.enabled, false);
  assert.equal(status.persistent, true);
  assert.equal(status.apiBaseUrl, legacyConnection.apiBaseUrl);
  assert.equal(fs.readFileSync(path.join(directory, 'looma-model-connection.json'), 'utf8').includes(legacyConnection.apiKey), false);
});

test('legacy migration archives encrypted credentials without replacing a configured provider or Ollama', async t => {
  for (const current of [connection, { apiBaseUrl: 'http://127.0.0.1:11434/v1', modelName: 'local-model', enabled: true }]) {
    const { service, directory } = fixture(t);
    await service.saveModelConnection(current);
    const before = await service.modelStatus();
    const primaryPath = path.join(directory, 'looma-model-connection.json');
    const originalFile = fs.readFileSync(primaryPath, 'utf8');
    assert.equal(typeof service.migrateLegacyConnection, 'function');
    assert.deepEqual(await service.migrateLegacyConnection(legacyConnection), { migrated: true });
    assert.deepEqual(await service.modelStatus(), before);
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), originalFile);
    const archivePath = path.join(directory, 'looma-legacy-connection.json');
    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    assert.equal(typeof archive.encryptedConnection, 'string');
    assert.equal(JSON.stringify(archive).includes(legacyConnection.apiKey), false);
    const decrypted = JSON.parse(Buffer.from(archive.encryptedConnection, 'base64').toString().replace(/^encrypted:/, ''));
    assert.equal(decrypted.connections.length, 1);
    assert.equal(decrypted.connections[0].apiKey, legacyConnection.apiKey);
    assert.deepEqual(await service.migrateLegacyConnection(legacyConnection), { migrated: true });
    assert.equal(fs.readFileSync(archivePath, 'utf8'), JSON.stringify(archive), 'retries preserve a completed identical archive');
    await service.clearModelConnection();
    assert.equal(fs.existsSync(primaryPath), false);
    assert.equal(fs.existsSync(archivePath), false);
  }
});

test('legacy migration keeps distinct previously archived credentials on a later migration', async t => {
  const { service, directory } = fixture(t);
  await service.saveModelConnection(connection);
  assert.equal(typeof service.migrateLegacyConnection, 'function');
  await service.migrateLegacyConnection(legacyConnection);
  await service.migrateLegacyConnection({ ...legacyConnection, apiKey: 'another-legacy-test-key' });
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'looma-legacy-connection.json'), 'utf8'));
  const decrypted = JSON.parse(Buffer.from(saved.encryptedConnection, 'base64').toString().replace(/^encrypted:/, ''));
  assert.equal(decrypted.connections.length, 2);
  assert.equal(decrypted.connections[0].apiKey, legacyConnection.apiKey);
});

test('legacy migration returns false without OS encryption or a successful disk write', async t => {
  const unavailable = fixture(t, { safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal(typeof unavailable.service.migrateLegacyConnection, 'function');
  assert.deepEqual(await unavailable.service.migrateLegacyConnection(legacyConnection), { migrated: false });
  assert.equal((await unavailable.service.modelStatus()).configured, false);
  assert.equal(fs.existsSync(path.join(unavailable.directory, 'looma-legacy-connection.json')), false);

  const { service, directory } = fixture(t);
  await service.saveModelConnection(connection);
  const status = await service.modelStatus();
  fs.mkdirSync(path.join(directory, 'looma-legacy-connection.json'));
  assert.deepEqual(await service.migrateLegacyConnection(legacyConnection), { migrated: false });
  assert.deepEqual(await service.modelStatus(), status);
  assert.equal(fs.existsSync(path.join(directory, 'looma-legacy-connection.json.tmp')), false);
});

test('model transport whitelists context, blocks redirects, and accepts only structured proposals', async t => {
  let outgoing;
  const expected = { engagements: [{ clientName: '李总', title: '咨询项目', budgetAmount: 300 }], tasks: [], warnings: [] };
  const { service } = fixture(t, { fetchImpl: async (url, options) => {
    outgoing = { url, options };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(expected) } }] }) };
  } });
  await service.saveModelConnection(connection);
  const result = await service.proposeModel({ ...request, context: {
    id: 'e-1', clientName: '李总', title: '咨询项目', internalContext: 'must-not-send', lifeVault: 'private-life', messages: ['history-must-not-send'],
  } });
  assert.deepEqual(JSON.parse(result.content), expected);
  assert.equal(outgoing.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(outgoing.options.redirect, 'error');
  assert.equal(outgoing.options.headers.Authorization, `Bearer ${connection.apiKey}`);
  assert.equal(outgoing.options.body.includes('must-not-send'), false);
  assert.equal(outgoing.options.body.includes('private-life'), false);
  assert.equal(outgoing.options.body.includes('history-must-not-send'), false);
  assert.equal(outgoing.options.body.includes('李总'), true);
});

test('unconfigured or disabled model does not call the transport', async t => {
  let calls = 0;
  const { service } = fixture(t, { fetchImpl: async () => { calls++; throw new Error('should not call'); } });
  await assert.rejects(service.proposeModel(request), /配置|启用/);
  await service.saveModelConnection({ ...connection, enabled: false });
  await assert.rejects(service.proposeModel(request), /启用/);
  assert.equal(calls, 0);
});

test('model rejects non-JSON, unsupported actions and HTTP errors without leaking provider text', async t => {
  let response;
  const { service } = fixture(t, { fetchImpl: async () => response });
  await service.saveModelConnection(connection);
  response = { ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) };
  await assert.rejects(service.proposeModel(request), /结构|JSON/);
  response = { ok: true, json: async () => ({ choices: [{ message: { content: '{"engagements":[],"tasks":[],"warnings":[],"tools":["delete"]}' } }] }) };
  await assert.rejects(service.proposeModel(request), /结构|字段/);
  response = { ok: false, status: 401, json: async () => ({ secret: connection.apiKey }) };
  await assert.rejects(service.proposeModel(request), error => /401/.test(error.message) && !error.message.includes(connection.apiKey));
});

test('model requests time out and can be cancelled by request ID', async t => {
  const waitForAbort = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const { service } = fixture(t, { fetchImpl: waitForAbort, timeoutMs: 10 });
  await service.saveModelConnection(connection);
  await assert.rejects(service.proposeModel(request), /超时/);
  const pending = service.proposeModel({ ...request, requestId: 'cancel-me' });
  await service.cancelModel('cancel-me');
  await assert.rejects(pending, /取消/);
});

test('transport error text is never echoed even if it resembles a local validation error', async t => {
  const { service } = fixture(t, { fetchImpl: async () => { throw new Error(`模型故障 ${connection.apiKey}`); } });
  await service.saveModelConnection(connection);
  await assert.rejects(service.proposeModel(request), error =>
    /连接失败/.test(error.message) && !error.message.includes(connection.apiKey));
});

test('changing providers does not silently reuse a previous provider key', async t => {
  const { service } = fixture(t);
  await service.saveModelConnection(connection);
  await assert.rejects(service.saveModelConnection({ apiBaseUrl: 'https://other.example.test/v1', modelName: 'test-model', enabled: true }), /API Key/);
  assert.equal((await service.modelStatus()).apiBaseUrl, connection.apiBaseUrl);
  const updated = await service.saveModelConnection({ apiBaseUrl: 'https://other.example.test/v1', modelName: 'test-model', enabled: false });
  assert.equal(updated.configured, false);
});

test('native notifications contain only a count and fail safely when unsupported', async t => {
  let shown;
  class FakeNotification {
    static isSupported() { return true; }
    constructor(options) { shown = options; }
    on() {}
    show() {}
  }
  const { service } = fixture(t, { Notification: FakeNotification });
  assert.deepEqual(await service.notifyDue({ count: 3 }), { shown: true });
  assert.equal(shown.body, '有 3 项待跟进事项，请打开工作台查看。');
  assert.equal(shown.title, 'Looma 跟进提醒');
  assert.deepEqual(await service.notifyDue({ count: 0 }), { shown: false });
  const unsupported = fixture(t, { Notification: { isSupported: () => false } });
  assert.deepEqual(await unsupported.service.notifyDue({ count: 3 }), { shown: false });
});

test('Electron wiring loads production build, keeps web security and authenticates every IPC', async t => {
  const { directory } = fixture(t);
  const handlers = new Map();
  let window;
  class FakeWindow {
    constructor(options) {
      window = this;
      this.options = options;
      this.webContents = {
        mainFrame: { url: '' }, setWindowOpenHandler: handler => { this.openHandler = handler; },
        on: (name, callback) => { this[name] = callback; },
      };
    }
    loadFile(file) { this.loadedFile = file; this.webContents.mainFrame.url = pathToFileURL(file).href; }
    loadURL(url) { this.loadedUrl = url; this.webContents.mainFrame.url = url; }
    setVisibleOnAllWorkspaces() {}
    on() {}
    minimize() { this.minimized = true; }
    close() {}
    setAlwaysOnTop() {}
    isAlwaysOnTop() { return true; }
    getSize() { return [460, 780]; }
    getPosition() { return [100, 100]; }
    setBounds() {}
    static getAllWindows() { return window ? [window] : []; }
  }
  const electron = {
    app: { isPackaged: false, getPath: () => directory, whenReady: () => Promise.resolve(), on() {}, quit() {}, setAppUserModelId() {} },
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 1024 }, workAreaSize: { width: 1280, height: 1024 } }) },
    safeStorage: { isEncryptionAvailable: () => false },
    Notification: { isSupported: () => false },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === './desktop-services.cjs' ? desktop : name === './persistence.cjs' ? { createPersistence: async () => ({ request: async () => ({}), close() {} }) } : require(name),
    __dirname: path.join(__dirname, '../electron'), process: { env: { NODE_ENV: 'production' }, platform: 'win32' }, console,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(window.loadedFile?.endsWith(path.join('dist', 'index.html')));
  assert.equal(window.loadedUrl, undefined);
  assert.equal(window.options.webPreferences.webSecurity, true);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.openHandler({ url: 'https://evil.test' }).action, 'deny');
  assert.ok(handlers.size >= 10);
  for (const handler of handlers.values()) {
    await assert.rejects(Promise.resolve().then(() => handler({ sender: {}, senderFrame: { url: 'https://evil.test' } }, {})), /来源|授权/);
  }
  const trusted = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  await handlers.get('window:minimize')(trusted);
  assert.equal(window.minimized, true);
});

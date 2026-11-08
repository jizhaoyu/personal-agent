const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

function preloadHarness() {
  let api;
  const ipc = new EventEmitter(), requests = [];
  ipc.invoke = async (...args) => { requests.push(args); return { ok: true }; };
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'electron/preload.cjs'), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: ipc,
  }) });
  return { api, ipc, requests };
}
test('todo preload retains cold-start focus until a subscriber and discards malformed events', async () => {
  const { api, ipc, requests } = preloadHarness();
  ipc.emit('todo:focus', {}, { space: 'work', id: 'cold-start', url: 'must-not-leak' });
  const values = [], off = api.onTodoFocus(value => values.push(JSON.parse(JSON.stringify(value))));
  assert.deepEqual(values, [{ space: 'work', id: 'cold-start' }]);
  ipc.emit('todo:focus', {}, { space: 'other', id: 'bad' });
  ipc.emit('todo:focus', {}, { space: 'life', id: 'next' });
  assert.deepEqual(values, [{ space: 'work', id: 'cold-start' }, { space: 'life', id: 'next' }]);
  off(); ipc.emit('todo:focus', {}, { space: 'work', id: 'later' }); assert.equal(values.length, 2);
  await api.todoRequest({ op: 'list' }); assert.equal(requests.at(-1)[0], 'todo:request');
});

async function launch() {
  const handlers = new Map(), timers = new Map(), app = new EventEmitter(), tray = new EventEmitter(), desktopCalls = [];
  let window, menu, stopped = false, quit = false, nextTimer = 0;
  class TestWindow extends EventEmitter {
    constructor() { super(); window = this; this.hidden = false; this.closed = false;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, messages: [], setWindowOpenHandler() {},
        isDestroyed: () => false, isCrashed: () => false, isLoading: () => false, send: (...args) => this.webContents.messages.push(args) }); }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    loadURL(url) { this.webContents.mainFrame.url = url; }
    setContentProtection() {} isDestroyed() { return this.closed; } isMinimized() { return false; }
    show() { this.hidden = false; } focus() {} hide() { this.hidden = true; }
    close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) { this.closed = true; this.emit('closed'); } }
    static getAllWindows() { return window?.closed ? [] : [window]; }
  }
  Object.assign(app, { isPackaged: false, getPath: () => '/test', whenReady: () => Promise.resolve(), setAppUserModelId() {},
    quit() { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); if (!prevented) { quit = true; app.emit('will-quit'); } } });
  Object.assign(tray, { setToolTip() {}, setContextMenu(value) { menu = value; }, destroy() {} });
  const electron = { app, BrowserWindow: TestWindow, Tray: class { constructor() { return tray; } }, Menu: { buildFromTemplate: value => value },
    nativeImage: { createFromBitmap: () => ({}) }, powerMonitor: new EventEmitter(),
    Notification: { isSupported: () => true }, ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 1024 } }) },
    globalShortcut: { register() {}, unregisterAll() {} }, dialog: { showMessageBox: async () => ({ response: 0 }) } };
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'electron/main.cjs'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === './persistence.cjs' ? { createPersistence: async () => ({ request: async () => ({ mode: 'life' }), close() {} }) }
      : name === './desktop-services.cjs' ? { ...require('../electron/desktop-services.cjs'), createDesktopServices: () => ({}) }
        : name.endsWith('todo-desktop.cjs') ? { createTodoDesktop: async options => ({ request: async command => { desktopCalls.push(command); return { ok: true }; },
          stop() { stopped = true; }, refresh: async () => {}, runExclusive: fn => fn() }) } : require(name),
    __dirname: path.join(process.cwd(), 'electron'), Buffer, process: { env: { NODE_ENV: 'production' }, platform: 'win32' }, console,
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, clearTimeout: id => timers.delete(id),
  });
  await new Promise(resolve => setImmediate(resolve));
  return { app, window, menu, desktopCalls, isStopped: () => stopped, hasQuit: () => quit,
    invoke: (channel, payload, foreign = false) => handlers.get(channel)({ sender: foreign ? {} : window.webContents, senderFrame: window.webContents.mainFrame }, payload) };
}
test('Windows tray close preserves draft, hides without quit, reopens, and explicit quit stops only after save', async () => {
  const h = await launch(); await h.invoke('window:closeGuardReady', true); h.window.close();
  assert.equal(h.window.hidden, false); assert.equal(h.isStopped(), false);
  await h.invoke('window:closePrepared', { requestId: h.window.webContents.messages[0][1], success: true });
  assert.equal(h.window.hidden, true); assert.equal(h.window.closed, false); assert.equal(h.hasQuit(), false);
  h.menu.find(item => item.label === '打开 Looma').click(); assert.equal(h.window.hidden, false);
  h.menu.find(item => item.label === '退出并停止提醒').click(); assert.equal(h.isStopped(), false); assert.equal(h.hasQuit(), false);
  await h.invoke('window:closePrepared', { requestId: h.window.webContents.messages.at(-1)[1], success: true });
  assert.equal(h.isStopped(), true); assert.equal(h.hasQuit(), true);
});
test('todo native IPC retains trusted-sender validation', async () => {
  const h = await launch();
  await assert.rejects(() => h.invoke('todo:request', { op: 'configure', enabled: true }, true), /未授权/);
  assert.equal(h.desktopCalls.length, 0);
  assert.equal((await h.invoke('todo:request', { op: 'list' })).ok, true); assert.equal(h.desktopCalls.length, 1);
});

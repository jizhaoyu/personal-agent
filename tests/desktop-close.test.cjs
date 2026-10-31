const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

async function launch() {
  const handlers = new Map(), timers = new Map(), dialogs = [];
  let window, nextTimer = 0;
  class TestWindow extends EventEmitter {
    constructor() {
      super(); window = this; this.closed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: '' }, messages: [], crashed: false,
        setWindowOpenHandler() {},
        isDestroyed: () => false,
        isCrashed: () => this.webContents.crashed,
        send: (...message) => this.webContents.messages.push(message),
      });
    }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    loadURL(url) { this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.closed; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (!prevented) { this.closed = true; this.emit('closed'); }
    }
    static getAllWindows() { return window?.closed ? [] : [window]; }
  }
  const app = { isPackaged: false, getPath: () => '/test-user-data', whenReady: () => Promise.resolve(), on() {}, quit() {}, setAppUserModelId() {} };
  const electron = {
    app, BrowserWindow: TestWindow,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 1024 } }) },
    dialog: { showMessageBox: (_parent, options) => new Promise(resolve => dialogs.push({ options, resolve })) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'electron/main.cjs'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === './persistence.cjs' ? { createPersistence: async () => ({ request() {}, close() {} }) } : name === './desktop-services.cjs' ? { ...require('../electron/desktop-services.cjs'), createDesktopServices: () => ({}) } : require(name),
    __dirname: path.join(process.cwd(), 'electron'), process: { env: { NODE_ENV: 'production' }, platform: 'win32' }, console,
    setTimeout: (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  await new Promise(resolve => setImmediate(resolve));
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return { window, timers, dialogs,
    async invoke(channel, payload) {
      assert.equal(typeof handlers.get(channel), 'function', `${channel} is registered`);
      return handlers.get(channel)(event, payload);
    },
  };
}

test('a registered renderer gets one close request and the window stays open until its saved acknowledgement', async () => {
  const app = await launch();
  await app.invoke('window:closeGuardReady', true);
  app.window.close(); app.window.close();
  assert.equal(app.window.closed, false);
  assert.equal(app.window.webContents.messages.length, 1);
  const [channel, requestId] = app.window.webContents.messages[0];
  assert.equal(channel, 'window:prepareClose'); assert.equal(typeof requestId, 'string');
  assert.equal([...app.timers.values()][0].ms, 4000);
  await app.invoke('window:closePrepared', { requestId, success: true });
  assert.equal(app.window.closed, true); assert.equal(app.timers.size, 0);
});

test('a failed save offers return by default and only an explicit discard closes the window', async () => {
  const app = await launch(); await app.invoke('window:closeGuardReady', true);
  app.window.close();
  const requestId = app.window.webContents.messages[0][1];
  await app.invoke('window:closePrepared', { requestId, success: false });
  assert.equal(app.window.closed, false); assert.equal(app.dialogs.length, 1);
  assert.equal(app.dialogs[0].options.defaultId, 0); assert.equal(app.dialogs[0].options.cancelId, 0);
  app.dialogs[0].resolve({ response: 0 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.window.closed, false);
  app.window.close(); const next = app.window.webContents.messages[1][1];
  await app.invoke('window:closePrepared', { requestId: next, success: false });
  app.dialogs[1].resolve({ response: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.window.closed, true);
});

test('timeout never silently discards and a late acknowledgement cannot close a later request', async () => {
  const app = await launch(); await app.invoke('window:closeGuardReady', true);
  app.window.close(); const oldRequest = app.window.webContents.messages[0][1];
  [...app.timers.values()][0].callback();
  assert.equal(app.window.closed, false); assert.equal(app.dialogs.length, 1);
  await app.invoke('window:closePrepared', { requestId: oldRequest, success: true });
  assert.equal(app.window.closed, false, 'a pending user decision takes precedence over a late acknowledgement');
  app.dialogs[0].resolve({ response: 0 }); await new Promise(resolve => setImmediate(resolve));
  app.window.close(); const newRequest = app.window.webContents.messages[1][1];
  assert.notEqual(oldRequest, newRequest);
  await app.invoke('window:closePrepared', { requestId: oldRequest, success: true });
  assert.equal(app.window.closed, false);
  await app.invoke('window:closePrepared', { requestId: newRequest, success: true });
  assert.equal(app.window.closed, true);
});

test('loading or crashed renderers do not prevent closing a window with no editable page', async () => {
  const loading = await launch(); loading.window.close(); assert.equal(loading.window.closed, true);
  const crashed = await launch(); await crashed.invoke('window:closeGuardReady', true);
  crashed.window.webContents.crashed = true; crashed.window.webContents.emit('render-process-gone');
  crashed.window.close(); assert.equal(crashed.window.closed, true);
});

test('preload subscriptions carry the close request token and remove only their own listener', async () => {
  let api; const listeners = new Map(), invocations = [];
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'electron/preload.cjs'), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: {
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); },
      invoke: async (channel, payload) => { invocations.push([channel, payload]); },
    },
  }) });
  assert.equal(typeof api.onBeforeClose, 'function'); assert.equal(typeof api.confirmClose, 'function');
  const seen = []; const unsubscribe = api.onBeforeClose(requestId => seen.push(requestId));
  listeners.get('window:prepareClose')({}, 'request-1');
  assert.deepEqual(seen, ['request-1']);
  await api.confirmClose(true, 'request-1');
  const [channel, payload] = invocations.find(([channel]) => channel === 'window:closePrepared');
  assert.equal(channel, 'window:closePrepared'); assert.equal(payload.requestId, 'request-1'); assert.equal(payload.success, true);
  unsubscribe(); assert.equal(listeners.has('window:prepareClose'), false);
  assert.equal(invocations.at(-1)[0], 'window:closeGuardReady'); assert.equal(invocations.at(-1)[1], false);
});

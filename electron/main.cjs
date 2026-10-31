const { app, BrowserWindow, ipcMain, screen, safeStorage, Notification, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { getWindowTarget, isTrustedSender, createDesktopServices } = require('./desktop-services.cjs');

let mainWindow = null;
let expectedUrl = '';
let services;
let persistence;
let createPersistence;
let persistenceInitError = '';
let importing = false;
let expandedBounds;
let compact = false;
let closeGuard;

const target = getWindowTarget({
  nodeEnv: process.env.NODE_ENV,
  isPackaged: app.isPackaged,
  indexPath: path.join(__dirname, '../dist/index.html'),
});

function trustedHandler(handler) {
  return async (event, payload) => {
    if (!isTrustedSender(event, mainWindow?.webContents, expectedUrl)) throw new Error('未授权的请求来源');
    return handler(payload);
  };
}

function registerHandlers() {
  const handle = (channel, callback) => ipcMain.handle(channel, trustedHandler(callback));
  handle('window:minimize', () => mainWindow.minimize());
  handle('window:close', () => mainWindow.close());
  handle('window:closeGuardReady', ready => {
    if (typeof ready !== 'boolean') throw new Error('退出保存状态无效');
    closeGuard?.setReady(ready);
  });
  handle('window:closePrepared', value => {
    if (!value || typeof value.success !== 'boolean' || typeof value.requestId !== 'string' || value.requestId.length > 100) throw new Error('退出保存回执无效');
    return closeGuard?.confirm(value) || { closed: false };
  });
  handle('window:setAlwaysOnTop', flag => {
    if (typeof flag !== 'boolean') throw new Error('置顶设置无效');
    mainWindow.setAlwaysOnTop(flag);
    return mainWindow.isAlwaysOnTop();
  });
  handle('window:setCompact', flag => {
    if (typeof flag !== 'boolean') throw new Error('窗口状态无效');
    if (compact === flag) return { compact };
    const bounds = mainWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    if (flag) {
      expandedBounds = bounds;
      mainWindow.setMinimumSize(220, 96);
      mainWindow.setResizable(false);
    } else {
      mainWindow.setResizable(true);
      mainWindow.setMinimumSize(Math.min(340, area.width), Math.min(480, area.height));
    }
    const target = flag ? { x: bounds.x + bounds.width - 220, y: bounds.y, width: 220, height: 96 } : (expandedBounds || bounds);
    const width = Math.min(target.width, area.width), height = Math.min(target.height, area.height);
    mainWindow.setBounds({ width, height, x: Math.max(area.x, Math.min(target.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(target.y, area.y + area.height - height)) });
    compact = flag;
    return { compact };
  });
  handle('store:request', command => {
    if (importing && !['init', 'bootstrap', 'get', 'list', 'stats'].includes(command?.op)) return { ok: false, error: '正在恢复完整备份，请稍候再修改资料。' };
    return persistence ? persistence.request(command) : { ok: false, error: persistenceInitError || '本地资料库尚未打开' };
  });
  handle('store:export', async () => {
    if (importing) throw new Error('正在恢复完整备份，请稍候再导出。');
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出 Looma 完整业务备份', defaultPath: `Looma-v5-${new Date().toISOString().slice(0, 10)}.jsonl`, filters: [{ name: 'Looma 备份', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    if (!persistence) throw new Error('本地资料库尚未打开，请先恢复有效备份');
    const saved = await persistence.exportToFile(result.filePath);
    if (!saved.ok) throw new Error(saved.error || '备份导出失败');
    return { canceled: false };
  });
  handle('store:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择完整业务备份（将替换两个空间）', properties: ['openFile'], filters: [{ name: 'Looma 备份', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    if (importing) throw new Error('已有完整备份正在恢复，请稍候。');
    importing = true;
    try {
    // When the original DB cannot open, validate into a fresh DB before preserving
    // the unreadable files and switching to the restored one. No invalid import moves them.
    let staged;
    const databasePath = path.join(app.getPath('userData'), 'looma.sqlite');
    const stagePath = `${databasePath}.recovery-${randomUUID()}`;
    if (!persistence) staged = await createPersistence({ filePath: stagePath });
    const restored = await (persistence || staged).restoreFromFile(result.filePaths[0]);
    staged?.close();
    if (staged && restored.ok) {
      const suffix = `.unreadable-${randomUUID()}`;
      const moved = [];
      try {
        for (const extra of ['', '-wal', '-shm']) {
          const original = databasePath + extra;
          if (fs.existsSync(original)) { fs.renameSync(original, original + suffix); moved.push([original, original + suffix]); }
        }
        fs.renameSync(stagePath, databasePath);
        persistence = await createPersistence({ filePath: databasePath }); persistenceInitError = '';
      } catch (error) {
        for (const [original, saved] of moved.reverse()) if (!fs.existsSync(original)) fs.renameSync(saved, original);
        throw error;
      }
    } else if (staged) {
      for (const extra of ['', '-wal', '-shm']) if (fs.existsSync(stagePath + extra)) fs.unlinkSync(stagePath + extra);
    }
    if (!restored.ok) throw new Error(restored.error || '备份校验失败，原数据未替换');
    return { canceled: false };
    } finally { importing = false; }
  });
  handle('window:resize', size => {
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) throw new Error('窗口尺寸无效');
    const area = screen.getPrimaryDisplay().workArea;
    const [oldWidth, oldHeight] = mainWindow.getSize();
    const [oldX, oldY] = mainWindow.getPosition();
    const width = Math.round(Math.min(area.width, Math.max(300, size.width)));
    const height = Math.round(Math.min(area.height, Math.max(100, size.height)));
    mainWindow.setBounds({
      width, height,
      x: Math.max(area.x, Math.min(area.x + area.width - width, oldX + oldWidth - width)),
      y: Math.max(area.y, Math.min(area.y + area.height - height, oldY + (oldHeight - height) / 2)),
    }, true);
  });
  handle('model:status', () => services.modelStatus());
  handle('model:save', value => services.saveModelConnection(value));
  handle('model:clear', () => services.clearModelConnection());
  handle('model:migrateLegacy', value => services.migrateLegacyConnection(value));
  handle('model:propose', value => services.proposeModel(value));
  handle('model:recall', async value => {
    const settings = await persistence.request({ op: 'settings' });
    return services.recallModel({ ...value, authorized: settings.memoryModelEnabled === true });
  });
  handle('model:cancel', requestId => services.cancelModel(requestId));
  handle('notifications:due', value => services.notifyDue(value));
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(480, area.width);
  const height = Math.min(820, area.height - 24);
  mainWindow = new BrowserWindow({
    width, height,
    x: Math.max(area.x, area.x + area.width - width - 24),
    y: Math.max(area.y, Math.round(area.y + (area.height - height) / 2)),
    minWidth: Math.min(340, area.width),
    minHeight: Math.min(480, area.height),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    hasShadow: true,
    title: 'Looma · 客户跟进伴侣',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  const window = mainWindow;
  let rendererReady = false, allowClose = false, pendingId = null, closeTimer = null, prompting = false;
  const clearCloseTimer = () => { if (closeTimer !== null) clearTimeout(closeTimer); closeTimer = null; };
  const closeSavedWindow = () => {
    clearCloseTimer(); pendingId = null; allowClose = true;
    if (!window.isDestroyed()) window.close();
  };
  const askBeforeDiscard = async () => {
    if (!pendingId || prompting || window.isDestroyed()) return;
    prompting = true; clearCloseTimer();
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: '草稿尚未确认保存',
        message: '尚未收到草稿保存完成的回执。',
        detail: '返回应用可继续整理或重试保存。若选择退出，只能恢复最近一次成功保存的草稿。',
        buttons: ['返回应用', '放弃未保存内容并退出'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response === 1) closeSavedWindow();
    } finally {
      pendingId = null; prompting = false;
    }
  };
  closeGuard = {
    setReady: ready => { rendererReady = ready; },
    confirm: ({ requestId, success }) => {
      if (pendingId !== requestId || prompting || window.isDestroyed()) return { closed: false };
      if (success) { closeSavedWindow(); return { closed: true }; }
      void askBeforeDiscard().catch(() => {});
      return { closed: false };
    },
  };
  window.on('close', event => {
    if (allowClose || !rendererReady || window.webContents.isDestroyed() || window.webContents.isCrashed()) return;
    event.preventDefault();
    if (pendingId) return;
    pendingId = randomUUID();
    closeTimer = setTimeout(() => { void askBeforeDiscard().catch(() => {}); }, 4000);
    window.webContents.send('window:prepareClose', pendingId);
  });
  window.webContents.on('did-start-loading', () => {
    rendererReady = false; pendingId = null; clearCloseTimer();
  });
  window.webContents.on('render-process-gone', () => {
    const wasClosing = pendingId !== null;
    rendererReady = false; pendingId = null; clearCloseTimer();
    if (wasClosing && !window.isDestroyed()) window.close();
  });
  expectedUrl = target.type === 'file' ? pathToFileURL(target.value).href : target.value;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== expectedUrl) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  if (target.type === 'file') mainWindow.loadFile(target.value);
  else mainWindow.loadURL(target.value);
  window.on('closed', () => { clearCloseTimer(); closeGuard = null; mainWindow = null; });
}

app.setAppUserModelId('com.looma.desktop');
app.whenReady().then(async () => {
  ({ createPersistence } = require('./persistence.cjs'));
  try { persistence = await createPersistence({ filePath: path.join(app.getPath('userData'), 'looma.sqlite') }); }
  catch { persistenceInitError = '本地资料库暂时无法读取，原文件已保留。请使用有效备份恢复。'; }
  services = createDesktopServices({ userDataPath: app.getPath('userData'), safeStorage, Notification });
  registerHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('will-quit', () => persistence?.close());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

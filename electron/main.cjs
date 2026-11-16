const { app, BrowserWindow, ipcMain, screen, safeStorage, Notification, dialog, globalShortcut, clipboard, Tray, Menu, nativeImage, powerMonitor, shell, net } = require('electron');
const { Buffer } = require('node:buffer');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { getWindowTarget, isTrustedSender, createDesktopServices, validateReleaseExternalUrl } = require('./desktop-services.cjs');
const { createTodoWindowGuard } = require(path.join(__dirname, 'todo-window.cjs'));

// === 1. 运行时反调试与未授权参数熔断自检 (Anti-Debugging & Tamper Defense) ===
const DANGEROUS_FLAGS = ['--remote-debugging-port', '--inspect', '--inspect-brk', '--remote-debugging-pipe'];
if (Array.isArray(process?.argv) && process.argv.some(arg => typeof arg === 'string' && DANGEROUS_FLAGS.some(flag => arg.toLowerCase().startsWith(flag)))) {
  console.error('[SECURITY DEFENSE] 检测到非授权调试参数注入，进程立即熔断退出。');
  process.exit(1);
}

// Windows 下透明窗体（transparent: true）配合 Electron 34 GPU 合成易触发 0xC0000005 崩溃或黑屏，
// 在应用就绪前改为软件合成以稳定渲染并保留圆角胶囊外观
if (process.platform === 'win32' && typeof app?.disableHardwareAcceleration === 'function') {
  app.disableHardwareAcceleration();
}

let mainWindow = null;
let expectedUrl = '';
let services;
let persistence;
let createPersistence;
let persistenceInitError = '';
let importing = false;
let expandedBounds;
let compact = false;
let contentProtected = false;
let closeGuard;
let todoDesktop;
let tray;
let actuallyQuitting = false;
let pendingTodoFocus = null;
let windowStateSaveTimer = null;

const ALLOWED_DOCUMENT_EXTENSIONS = new Set(['png', 'txt', 'json', 'jsonl']);
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const DOCUMENT_FILTER_NAMES = {
  png: 'PNG 图片',
  txt: '文本文件',
  json: 'JSON 文件',
  jsonl: 'JSONL 文件',
};

function getWorkAreaForBounds(bounds) {
  try {
    if (bounds && typeof screen?.getDisplayMatching === 'function') {
      const display = screen.getDisplayMatching(bounds);
      if (display?.workArea) return display.workArea;
    }
  } catch { /* ignore */ }
  return screen.getPrimaryDisplay().workArea;
}

function getSafeWindowBounds(win) {
  if (!win) return null;
  try {
    if (typeof win.getBounds === 'function') return win.getBounds();
    if (typeof win.getPosition === 'function' && typeof win.getSize === 'function') {
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      return { x, y, width, height };
    }
  } catch { /* ignore */ }
  return null;
}

function clampBoundsToArea(bounds, area, { minWidth = 340, minHeight = 480 } = {}) {
  const effectiveMinW = Math.min(minWidth, area.width);
  const effectiveMinH = Math.min(minHeight, area.height);
  const width = Math.round(Math.min(area.width, Math.max(effectiveMinW, Number.isFinite(bounds?.width) ? bounds.width : 480)));
  const height = Math.round(Math.min(area.height, Math.max(effectiveMinH, Number.isFinite(bounds?.height) ? bounds.height : 820)));
  const defaultX = area.x + area.width - width - 24;
  const defaultY = area.y + Math.round((area.height - height) / 2);
  const rawX = Number.isFinite(bounds?.x) ? bounds.x : defaultX;
  const rawY = Number.isFinite(bounds?.y) ? bounds.y : defaultY;
  return {
    width,
    height,
    x: Math.max(area.x, Math.min(area.x + area.width - width, Math.round(rawX))),
    y: Math.max(area.y, Math.min(area.y + area.height - height, Math.round(rawY))),
  };
}

function getWindowStatePath() {
  try {
    const dir = app?.getPath?.('userData');
    return dir ? path.join(dir, 'looma-window-state.json') : '';
  } catch {
    return '';
  }
}

function loadWindowState() {
  const primaryArea = screen.getPrimaryDisplay().workArea;
  const defaultBounds = clampBoundsToArea(
    { width: Math.min(480, primaryArea.width), height: Math.min(820, primaryArea.height - 24) },
    primaryArea,
  );
  const defaults = { bounds: defaultBounds, alwaysOnTop: true };
  const filePath = getWindowStatePath();
  if (!filePath) return defaults;
  try {
    if (!fs.existsSync(filePath)) return defaults;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
    const alwaysOnTop = typeof raw.alwaysOnTop === 'boolean' ? raw.alwaysOnTop : true;
    const b = raw.bounds;
    if (!b || typeof b !== 'object' || !Number.isFinite(b.width) || !Number.isFinite(b.height)
        || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
      return { bounds: defaultBounds, alwaysOnTop };
    }
    const area = getWorkAreaForBounds(b);
    return { bounds: clampBoundsToArea(b, area), alwaysOnTop };
  } catch {
    return defaults;
  }
}

function saveWindowStateNow() {
  if (windowStateSaveTimer !== null && typeof clearTimeout === 'function') {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  const filePath = getWindowStatePath();
  if (!filePath || !mainWindow || (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed())) return;
  try {
    const currentBounds = compact ? expandedBounds : getSafeWindowBounds(mainWindow);
    if (!currentBounds || !Number.isFinite(currentBounds.width) || !Number.isFinite(currentBounds.height)) return;
    const alwaysOnTop = typeof mainWindow.isAlwaysOnTop === 'function' ? !!mainWindow.isAlwaysOnTop() : true;
    const payload = {
      version: 1,
      alwaysOnTop,
      bounds: {
        x: Math.round(currentBounds.x),
        y: Math.round(currentBounds.y),
        width: Math.round(currentBounds.width),
        height: Math.round(currentBounds.height),
      },
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    // Ignore non-writable userData paths in restricted/mock environments.
  }
}

function scheduleWindowStateSave() {
  if (typeof setTimeout !== 'function') {
    saveWindowStateNow();
    return;
  }
  if (windowStateSaveTimer !== null && typeof clearTimeout === 'function') clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    saveWindowStateNow();
  }, 250);
  windowStateSaveTimer?.unref?.();
}

function ensureWindowOnScreen() {
  if (!mainWindow || (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed())) return;
  const bounds = getSafeWindowBounds(mainWindow);
  if (!bounds || typeof mainWindow.setBounds !== 'function') return;
  const area = getWorkAreaForBounds(bounds);
  const clamped = clampBoundsToArea(bounds, area, {
    minWidth: compact ? 220 : 340,
    minHeight: compact ? 96 : 480,
  });
  if (clamped.x !== bounds.x || clamped.y !== bounds.y || clamped.width !== bounds.width || clamped.height !== bounds.height) {
    mainWindow.setBounds(clamped);
  }
}

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

// 剪贴板敏感凭据与高危数据特征过滤
function sanitizeClipboard(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 12000) return '';
  // 阻断 RSA / EC / OPENSSH 等私钥特征，防止误触泄密
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i.test(trimmed)) {
    return '[SECURITY INTERCEPT] 检测到包含私钥特征，底座已自动阻止载入待办，保护您的凭据安全。';
  }
  return trimmed;
}

function applyContentProtection(flag) {
  const enabled = !!flag;
  if (!mainWindow || (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed())) {
    contentProtected = false;
    return false;
  }
  if (contentProtected === enabled) return contentProtected;
  if (typeof mainWindow.setContentProtection === 'function') {
    mainWindow.setContentProtection(enabled);
  }
  contentProtected = enabled;
  return contentProtected;
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
    const current = mainWindow.isAlwaysOnTop();
    saveWindowStateNow();
    return current;
  });
  handle('window:setContentProtection', flag => {
    if (typeof flag !== 'boolean') throw new Error('防截屏参数无效');
    return applyContentProtection(flag);
  });
  handle('window:isContentProtected', () => contentProtected);
  handle('window:setCompact', flag => {
    if (typeof flag !== 'boolean') throw new Error('窗口状态无效');
    if (compact === flag) return { compact };
    const bounds = getSafeWindowBounds(mainWindow) || { x: 0, y: 0, width: 480, height: 820 };
    if (flag) {
      expandedBounds = bounds;
      mainWindow.setMinimumSize?.(220, 96);
      mainWindow.setResizable?.(false);
    } else {
      mainWindow.setResizable?.(true);
    }
    const target = flag ? { x: bounds.x + bounds.width - 220, y: bounds.y, width: 220, height: 96 } : (expandedBounds || bounds);
    const area = getWorkAreaForBounds(target);
    if (!flag) {
      mainWindow.setMinimumSize?.(Math.min(340, area.width), Math.min(480, area.height));
    }
    const width = Math.min(target.width, area.width), height = Math.min(target.height, area.height);
    mainWindow.setBounds({ width, height, x: Math.max(area.x, Math.min(target.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(target.y, area.y + area.height - height)) });
    compact = flag;
    if (flag) saveWindowStateNow();
    return { compact };
  });
  handle('store:request', command => {
    if (importing && !['init', 'bootstrap', 'get', 'list', 'stats'].includes(command?.op)) return { ok: false, error: '正在恢复完整备份，请稍候再修改资料。' };
    const request = () => persistence ? persistence.request(command) : { ok: false, error: persistenceInitError || '本地资料库尚未打开' };
    return todoDesktop ? todoDesktop.runExclusive(request) : request();
  });
  handle('todo:request', command => {
    if (importing) return { ok: false, error: '正在恢复完整备份，请稍候再修改待办。' };
    return todoDesktop ? todoDesktop.request(command) : { ok: false, error: persistenceInitError || '待办后台尚未打开' };
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
  handle('store:saveDocument', async payload => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('保存参数无效');
    }
    if (typeof payload.suggestedName !== 'string' || !payload.suggestedName.trim() || payload.suggestedName.length > 180) {
      throw new Error('文件名无效');
    }
    if (typeof payload.data !== 'string' || !payload.data) {
      throw new Error('保存内容为空');
    }
    let safeName = path.basename(payload.suggestedName.trim()).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '');
    let ext = path.extname(safeName).slice(1).toLowerCase();
    if (!ext) {
      const mime = typeof payload.mimeType === 'string' ? payload.mimeType.trim().toLowerCase() : '';
      ext = mime === 'image/png' ? 'png' : mime === 'application/json' ? 'json' : 'txt';
      safeName = `${safeName || 'Looma-export'}.${ext}`;
    }
    if (!ALLOWED_DOCUMENT_EXTENSIONS.has(ext)) {
      throw new Error('不支持保存该文件类型');
    }

    let buffer;
    if (payload.isBase64) {
      const raw = payload.data.trim().replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
      if (!raw || raw.length > 22 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
        throw new Error('文件编码无效或超出 16MB 限制');
      }
      buffer = Buffer.from(raw, 'base64');
    } else {
      if (Buffer.byteLength(payload.data, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw new Error('文件大小超出 16MB 限制');
      }
      buffer = Buffer.from(payload.data, 'utf8');
    }
    if (!buffer.length || buffer.length > MAX_DOCUMENT_BYTES) {
      throw new Error('文件大小无效或超出 16MB 限制');
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存文件',
      defaultPath: safeName,
      filters: [{ name: DOCUMENT_FILTER_NAMES[ext] || ext.toUpperCase(), extensions: [ext] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const chosenExt = path.extname(result.filePath).slice(1).toLowerCase();
    if (chosenExt && !ALLOWED_DOCUMENT_EXTENSIONS.has(chosenExt)) {
      throw new Error('不支持保存该文件扩展名');
    }
    const targetPath = chosenExt ? result.filePath : `${result.filePath}.${ext}`;
    await fs.promises.writeFile(targetPath, buffer);
    return { canceled: false };
  });
  handle('store:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择完整业务备份（将替换两个空间）', properties: ['openFile'], filters: [{ name: 'Looma 备份', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    if (importing) throw new Error('已有完整备份正在恢复，请稍候。');
    importing = true;
    todoDesktop?.suspend();
    try {
      // Drain earlier native writes before taking over the database for restore.
      await todoDesktop?.flush();
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
    } finally { importing = false; await todoDesktop?.resume().catch(() => {}); }
  });
  handle('window:resize', size => {
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) throw new Error('窗口尺寸无效');
    const currentBounds = getSafeWindowBounds(mainWindow);
    const area = getWorkAreaForBounds(currentBounds);
    const [oldWidth, oldHeight] = typeof mainWindow.getSize === 'function' ? mainWindow.getSize() : [currentBounds?.width ?? 480, currentBounds?.height ?? 820];
    const [oldX, oldY] = typeof mainWindow.getPosition === 'function' ? mainWindow.getPosition() : [currentBounds?.x ?? area.x, currentBounds?.y ?? area.y];
    const width = Math.round(Math.min(area.width, Math.max(300, size.width)));
    const height = Math.round(Math.min(area.height, Math.max(100, size.height)));
    mainWindow.setBounds({
      width, height,
      x: Math.max(area.x, Math.min(area.x + area.width - width, oldX + oldWidth - width)),
      y: Math.max(area.y, Math.min(area.y + area.height - height, oldY + (oldHeight - height) / 2)),
    }, true);
    if (!compact) scheduleWindowStateSave();
  });
  handle('model:status', () => services.modelStatus());
  handle('model:save', value => services.saveModelConnection(value));
  handle('model:clear', () => services.clearModelConnection());
  handle('model:migrateLegacy', value => services.migrateLegacyConnection(value));
  handle('model:propose', value => services.proposeModel(value));
  handle('model:captureAgent', value => services.captureAgentModel(value));
  handle('model:recall', async value => {
    const settings = await persistence.request({ op: 'settings' });
    return services.recallModel({ ...value, authorized: settings.memoryModelEnabled === true });
  });
  handle('model:cancel', requestId => services.cancelModel(requestId));
  handle('notifications:due', value => services.notifyDue(value));
  handle('update:check', () => services.checkForUpdates());
  handle('update:openUrl', async url => {
    const safeUrl = validateReleaseExternalUrl(url);
    if (!safeUrl) throw new Error('仅允许通过 HTTPS 打开本项目的 GitHub Releases 页面或官方发行资源');
    await shell.openExternal(safeUrl);
    return { opened: true, url: safeUrl };
  });
  handle('clipboard:read', () => {
    try {
      const raw = clipboard.readText();
      return sanitizeClipboard(raw);
    } catch {
      return '';
    }
  });
}

function showMainWindow(focus) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized?.()) mainWindow.restore();
  ensureWindowOnScreen();
  mainWindow.show(); mainWindow.focus();
  if (focus) {
    if (mainWindow.webContents.isLoading?.()) pendingTodoFocus = focus;
    else mainWindow.webContents.send('todo:focus', focus);
  }
}

function quitAfterSave() {
  actuallyQuitting = true;
  todoDesktop?.stop();
  app.quit();
}

function createTray() {
  if (process.platform !== 'win32' || !Tray || !Menu || !nativeImage) return;
  // A local generated bitmap works in packaged builds without external icon files.
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4, ink = x >= 4 && x <= 6 && y >= 3 && y <= 12 || y >= 10 && y <= 12 && x >= 4 && x <= 12;
    pixels[i] = ink ? 248 : 68; pixels[i + 1] = ink ? 248 : 103; pixels[i + 2] = ink ? 248 : 89; pixels[i + 3] = 255;
  }
  tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
  tray.setToolTip('Looma · 待办后台运行');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Looma', click: () => showMainWindow() },
    { label: '打开待办', click: () => { void (async () => {
      const result = await persistence?.request({ op: 'init' });
      showMainWindow({ space: result?.mode === 'life' ? 'life' : 'work', id: '' });
    })(); } },
    { type: 'separator' },
    { label: '退出并停止提醒', click: () => closeGuard ? closeGuard.requestQuit() : quitAfterSave() },
  ]));
  tray.on('double-click', () => showMainWindow());
}

function registerGlobalShortcuts() {
  try {
    globalShortcut.register('CommandOrControl+Shift+L', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();

      try {
        const raw = clipboard.readText();
        const safe = sanitizeClipboard(raw);
        if (safe) {
          mainWindow.webContents.send('quick-capture:paste', safe);
        }
      } catch (err) {
        console.warn('[Looma] 剪贴板读取异常:', err);
      }
    });
  } catch (err) {
    console.warn('[Looma] 注册全局快捷键 CommandOrControl+Shift+L 失败:', err);
  }
}

function createWindow() {
  const savedState = loadWindowState();
  const area = getWorkAreaForBounds(savedState.bounds);
  const { width, height, x, y } = savedState.bounds;
  contentProtected = false;
  mainWindow = new BrowserWindow({
    width, height,
    x,
    y,
    minWidth: Math.min(340, area.width),
    minHeight: Math.min(480, area.height),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: savedState.alwaysOnTop,
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
      devTools: !app.isPackaged, // 生产打包环境下彻底封禁 DevTools 动态挂接
    },
  });

  // === 2. 窗口防截屏与录屏物理隐身（默认关闭以兼容透明窗口与远程桌面，由桌面设置按需开启） ===

  // === 3. 生产环境快捷键防逆向注入拦截 ===
  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      // 拦截 F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+U 等逆向调试组合键
      if (input.key === 'F12' || (input.control && input.shift && ['I', 'J', 'C'].includes(input.key.toUpperCase())) || (input.control && input.key.toUpperCase() === 'U')) {
        event.preventDefault();
      }
    });
  }

  const window = mainWindow;
  const guard = createTodoWindowGuard({
    window, hideToTray: process.platform === 'win32' && !!tray,
    onQuit: quitAfterSave,
    ...(typeof setTimeout === 'function' ? { setTimeout, clearTimeout } : {}),
    askDiscard: async () => {
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: '草稿尚未确认保存',
        message: '尚未收到草稿保存完成的回执。',
        detail: '返回应用可继续整理或重试保存。若选择退出，只能恢复最近一次成功保存的草稿。',
        buttons: ['返回应用', '放弃未保存内容并退出'], defaultId: 0, cancelId: 0, noLink: true,
      });
      return result.response === 1;
    },
  });
  closeGuard = guard;
  window.on('move', () => {
    if (!compact && !window.isMinimized?.()) scheduleWindowStateSave();
  });
  window.on('resize', () => {
    if (!compact && !window.isMinimized?.()) scheduleWindowStateSave();
  });
  window.on('close', event => {
    saveWindowStateNow();
    guard.onClose(event);
  });
  window.webContents.on('did-start-loading', guard.onLoading);
  window.webContents.on('render-process-gone', guard.onRendererGone);
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[Looma] 页面加载失败:', errorCode, errorDescription, validatedURL);
  });
  window.webContents.on('did-finish-load', () => {
    if (pendingTodoFocus) { window.webContents.send('todo:focus', pendingTodoFocus); pendingTodoFocus = null; }
  });
  expectedUrl = target.type === 'file' ? pathToFileURL(target.value).href : target.value;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== expectedUrl) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  if (target.type === 'file') mainWindow.loadFile(target.value);
  else mainWindow.loadURL(target.value);
  window.on('closed', () => {
    if (windowStateSaveTimer !== null && typeof clearTimeout === 'function') {
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
    }
    guard.dispose(); closeGuard = null; contentProtected = false; mainWindow = null;
  });
}

app.setAppUserModelId('com.looma.desktop');
app.whenReady().then(async () => {
  ({ createPersistence } = require('./persistence.cjs'));
  try { persistence = await createPersistence({ filePath: path.join(app.getPath('userData'), 'looma.sqlite') }); }
  catch { persistenceInitError = '本地资料库暂时无法读取，原文件已保留。请使用有效备份恢复。'; }
  services = createDesktopServices({
    userDataPath: app.getPath('userData'),
    safeStorage,
    Notification,
    ...(net && typeof net.fetch === 'function' ? { updateFetchImpl: net.fetch.bind(net) } : {}),
  });
  if (Notification?.isSupported) {
    const { createTodoDesktop } = require(path.join(__dirname, 'todo-desktop.cjs'));
    todoDesktop = await createTodoDesktop({ getPersistence: () => persistence, Notification, onFocus: showMainWindow });
  }
  registerHandlers();
  createTray();
  createWindow();
  registerGlobalShortcuts();
  if (typeof screen?.on === 'function') {
    screen.on('display-metrics-changed', ensureWindowOnScreen);
    screen.on('display-removed', ensureWindowOnScreen);
  }
  app.on('activate', () => {
    showMainWindow();
  });
  powerMonitor?.on('resume', () => { void todoDesktop?.refresh().catch(() => {}); });
  powerMonitor?.on('unlock-screen', () => { void todoDesktop?.refresh().catch(() => {}); });
});
app.on('before-quit', event => {
  if (actuallyQuitting) return;
  event.preventDefault();
  if (closeGuard) closeGuard.requestQuit();
  else quitAfterSave();
});
app.on('will-quit', () => {
  saveWindowStateNow();
  try { globalShortcut.unregisterAll(); } catch (e) {}
  todoDesktop?.stop(); tray?.destroy();
  persistence?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});

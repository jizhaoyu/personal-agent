const { contextBridge, ipcRenderer } = require('electron');

const todoFocusHandlers = new Set();
let queuedTodoFocus = null;
// Notification clicks may arrive while React is still mounting after cold start.
ipcRenderer.on('todo:focus', (_event, value) => {
  if (!value || !['life', 'work'].includes(value.space) || typeof value.id !== 'string') return;
  const focus = { space: value.space, id: value.id };
  if (!todoFocusHandlers.size) queuedTodoFocus = focus;
  else for (const handler of todoFocusHandlers) handler(focus);
});

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onBeforeClose: handler => {
    if (typeof handler !== 'function') throw new TypeError('退出保存处理器无效');
    const listener = (_event, requestId) => handler(requestId);
    ipcRenderer.on('window:prepareClose', listener);
    void ipcRenderer.invoke('window:closeGuardReady', true).catch(() => {});
    return () => {
      ipcRenderer.removeListener('window:prepareClose', listener);
      void ipcRenderer.invoke('window:closeGuardReady', false).catch(() => {});
    };
  },
  confirmClose: (success, requestId) => ipcRenderer.invoke('window:closePrepared', { success, requestId }),
  resizeWindow: (size) => ipcRenderer.invoke('window:resize', size),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:setAlwaysOnTop', flag),
  setCompact: (flag) => ipcRenderer.invoke('window:setCompact', flag),
  storeRequest: command => ipcRenderer.invoke('store:request', command),
  todoRequest: command => ipcRenderer.invoke('todo:request', command),
  onTodoFocus: handler => {
    if (typeof handler !== 'function') throw new TypeError('待办定位处理器无效');
    todoFocusHandlers.add(handler);
    if (queuedTodoFocus) { const focus = queuedTodoFocus; queuedTodoFocus = null; handler(focus); }
    return () => todoFocusHandlers.delete(handler);
  },
  exportDataBackup: () => ipcRenderer.invoke('store:export'),
  importDataBackup: () => ipcRenderer.invoke('store:import'),
  modelStatus: () => ipcRenderer.invoke('model:status'),
  saveModelConnection: (connection) => ipcRenderer.invoke('model:save', connection),
  clearModelConnection: () => ipcRenderer.invoke('model:clear'),
  migrateLegacyConnection: (connection) => ipcRenderer.invoke('model:migrateLegacy', connection),
  proposeModel: (request) => ipcRenderer.invoke('model:propose', request),
  captureAgentModel: (request) => ipcRenderer.invoke('model:captureAgent', request),
  recallModel: (request) => ipcRenderer.invoke('model:recall', request),
  cancelModel: (requestId) => ipcRenderer.invoke('model:cancel', requestId),
  notifyDue: (summary) => ipcRenderer.invoke('notifications:due', summary),
  onQuickCapture: handler => {
    if (typeof handler !== 'function') throw new TypeError('快速整理处理器无效');
    const listener = (_event, text) => handler(text);
    ipcRenderer.on('quick-capture:paste', listener);
    return () => ipcRenderer.removeListener('quick-capture:paste', listener);
  },
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  setContentProtection: flag => ipcRenderer.invoke('window:setContentProtection', flag),
  isContentProtected: () => ipcRenderer.invoke('window:isContentProtected'),
});

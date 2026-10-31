const { contextBridge, ipcRenderer } = require('electron');

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
  exportDataBackup: () => ipcRenderer.invoke('store:export'),
  importDataBackup: () => ipcRenderer.invoke('store:import'),
  modelStatus: () => ipcRenderer.invoke('model:status'),
  saveModelConnection: (connection) => ipcRenderer.invoke('model:save', connection),
  clearModelConnection: () => ipcRenderer.invoke('model:clear'),
  migrateLegacyConnection: (connection) => ipcRenderer.invoke('model:migrateLegacy', connection),
  proposeModel: (request) => ipcRenderer.invoke('model:propose', request),
  recallModel: (request) => ipcRenderer.invoke('model:recall', request),
  cancelModel: (requestId) => ipcRenderer.invoke('model:cancel', requestId),
  notifyDue: (summary) => ipcRenderer.invoke('notifications:due', summary),
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  resizeWindow: (size) => ipcRenderer.invoke('window:resize', size),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:setAlwaysOnTop', flag),
});

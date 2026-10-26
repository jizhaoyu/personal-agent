const { app, BrowserWindow, ipcMain, screen, Tray, Menu } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;

const isDev = process.env.NODE_ENV !== 'production' || !app.isPackaged;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  // 初始窗口大小：放置在屏幕右侧中下方
  const initialWidth = 380;
  const initialHeight = 580;
  const initialX = Math.round(screenWidth - initialWidth - 24);
  const initialY = Math.round((screenHeight - initialHeight) / 2);

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    x: initialX,
    y: initialY,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false, // 允许读取本地图片及预览
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 点击外部时不抢焦点
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC 通信处理
ipcMain.handle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window:close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window:resize', (event, { width, height }) => {
  if (mainWindow) {
    const [currentWidth, currentHeight] = mainWindow.getSize();
    const [currentX, currentY] = mainWindow.getPosition();
    
    // 向左上扩展，保持右侧对齐
    const deltaW = width - currentWidth;
    const deltaH = height - currentHeight;
    mainWindow.setBounds({
      x: currentX - deltaW,
      y: Math.max(20, currentY - deltaH / 2),
      width,
      height
    }, true);
  }
});

ipcMain.handle('window:setAlwaysOnTop', (event, flag) => {
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(flag);
    return mainWindow.isAlwaysOnTop();
  }
  return false;
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

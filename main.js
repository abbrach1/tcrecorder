const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false
    }
  });

  win.loadURL('http://localhost:3000');
}

ipcMain.on('save-audio', (event, dataUrl) => {
  // Parse base64 data
  const matches = dataUrl.match(/^data:audio\/webm;base64,(.+)$/);
  if (!matches) return;
  const buffer = Buffer.from(matches[1], 'base64');
  const downloads = path.join(os.homedir(), 'Downloads');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(downloads, `shiur-${timestamp}.webm`);
  fs.writeFile(filePath, buffer, err => {
    if (err) console.error('Failed to save audio:', err);
  });
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

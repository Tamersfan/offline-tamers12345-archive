// main.js

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

console.log('▶️  Starting Electron main process');

function createWindow() {
  console.log('   ↳ createWindow() called');
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html')
     .then(() => console.log('   ↳ index.html loaded'))
     .catch(err => console.error('   ✖ failed to load index.html:', err));
}

app.whenReady()
  .then(() => {
    console.log('   ↳ app.whenReady resolved');
    createWindow();

    // ── Changed here: autoUpdater.checkForUpdatesAndNotify() ────────────────────────────────
    autoUpdater.checkForUpdatesAndNotify();
  })
  .catch(err => console.error('   ✖ app.whenReady error:', err));

app.on('window-all-closed', () => {
  console.log('   ↳ all windows closed, quitting');
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  console.log('   ↳ app.activate');
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Handler for get-settings
ipcMain.handle('get-settings', async () => {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('   ✖ failed to read settings:', e);
  }
  return {};
});

// Handler for selecting video folder
ipcMain.handle('select-video-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length > 0) {
    const folderPath = result.filePaths[0];
    fs.writeFileSync(settingsPath, JSON.stringify({ videoPath: folderPath }, null, 2));
    return folderPath;
  }
  return null;
});

// Handler for reading DeviantArt images
ipcMain.handle('read-image-files', async () => {
  const folder = path.join(__dirname, 'deviantart', 'deviantart art framed');
  const files = fs.readdirSync(folder).filter(f => /\.(png|jpe?g|gif)$/i.test(f));
  return files.map(filename => ({ filename, path: path.join(folder, filename) }));
});

// Handler for reading your archived Tumblr HTML files
ipcMain.handle('read-tumblr-html', async () => {
  const folder = path.join(__dirname, 'tumblr');
  if (!fs.existsSync(folder)) return [];
  const files = fs.readdirSync(folder)
    .filter(f => f.toLowerCase().endsWith('.html'))
    .sort();
  return files.map(f => path.join('tumblr', f));
});

// ─── Auto‐Updater Events ──────────────────────────────────────────────────

// 1) When an update is available
autoUpdater.on('update-available', (info) => {
  console.log('   ↳ Update available:', info);
  // We wait for 'update-downloaded' before prompting the user
});

// 2) When the update has been downloaded
autoUpdater.on('update-downloaded', (info) => {
  console.log('   ↳ Update downloaded:', info);
  dialog.showMessageBox({
    type: 'question',
    buttons: ['Restart & Install', 'Later'],
    defaultId: 0,
    title: 'Install Updates',
    message: 'An update has been downloaded. Restart the app to apply the updates.',
    detail: info.releaseNotes || ''
  }).then(result => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

// 3) If there’s an error during update
autoUpdater.on('error', (err) => {
  console.error('   ↳ Auto‐updater error:', err);
});

// 4) (Optional) Progress reporting
autoUpdater.on('download-progress', (progressObj) => {
  console.log(`   ↳ Download speed: ${progressObj.bytesPerSecond} - Downloaded ${Math.round(progressObj.percent)}%`);
});

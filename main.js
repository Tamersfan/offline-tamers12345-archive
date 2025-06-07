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

    // ── Manual update flow ─────────────────────────────────────────────────
    autoUpdater.autoDownload = false;  // don’t download until user agrees
    console.log('   ↳ Checking for updates…');
    autoUpdater.checkForUpdates();
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

// ── IPC Handlers ───────────────────────────────────────────────────────────
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

ipcMain.handle('select-video-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length > 0) {
    const folderPath = result.filePaths[0];
    fs.writeFileSync(settingsPath, JSON.stringify({ videoPath: folderPath }, null, 2));
    return folderPath;
  }
  return null;
});

ipcMain.handle('read-image-files', async () => {
  const folder = path.join(__dirname, 'deviantart', 'deviantart art framed');
  const files = fs.readdirSync(folder).filter(f => /\.(png|jpe?g|gif)$/i.test(f));
  return files.map(filename => ({ filename, path: path.join(folder, filename) }));
});

ipcMain.handle('read-tumblr-html', async () => {
  const folder = path.join(__dirname, 'tumblr');
  if (!fs.existsSync(folder)) return [];
  const files = fs.readdirSync(folder)
    .filter(f => f.toLowerCase().endsWith('.html'))
    .sort();
  return files.map(f => path.join('tumblr', f));
});

// ── Auto‐Updater Events ──────────────────────────────────────────────────

// 1) Update is available: ask the user if they want to download it now
autoUpdater.on('update-available', info => {
  console.log('   ↳ Update available:', info);
  dialog.showMessageBox({
    type: 'info',
    buttons: ['Download update', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update Available',
    message: `Version ${info.version} is available. Would you like to download it now?`,
    detail: info.releaseName || ''
  }).then(({ response }) => {
    if (response === 0) {
      console.log('   ↳ User chose to download update');
      autoUpdater.downloadUpdate();
    } else {
      console.log('   ↳ User postponed the update');
    }
  });
});

// 2) When the update has been downloaded: prompt to install
autoUpdater.on('update-downloaded', info => {
  console.log('   ↳ Update downloaded:', info);

  // strip HTML tags from releaseNotes
  const plainNotes = (info.releaseNotes || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  dialog.showMessageBox({
    type: 'question',
    buttons: [
      'Restart program now and install update.',
      'Later, install the update when I close the program.'
    ],
    defaultId: 0,
    cancelId: 1,
    title: 'Install Updates',
    message: 'The update has been downloaded and is ready.',
    detail: plainNotes
  }).then(({ response }) => {
    if (response === 0) {
      console.log('   ↳ Installing update now');
      autoUpdater.quitAndInstall();
    } else {
      console.log('   ↳ Will install on exit');
    }
  });
});

// 3) If there’s an error during update
autoUpdater.on('error', err => {
  console.error('   ↳ Auto‐updater error:', err);
});

// 4) Progress reporting (optional)
autoUpdater.on('download-progress', progressObj => {
  console.log(`   ↳ Download speed: ${progressObj.bytesPerSecond} — ${Math.round(progressObj.percent)}%`);
});

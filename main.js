// main.js
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { autoUpdater } = require('electron-updater');

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// ── Only check for missing videos uploaded after this date ───────────────
const MISSING_SINCE_DATE = "20250606";  // YYYYMMDD cutoff

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

ipcMain.handle('read-tumblr2-html', async () => {
  const folder = path.join(__dirname, 'tumblr2');
  if (!fs.existsSync(folder)) return [];
  const files = fs.readdirSync(folder)
    .filter(f => f.toLowerCase().endsWith('.html'))
    .sort();
  return files.map(f => path.join('tumblr2', f));
});

// ── Auto‐Updater Events ──────────────────────────────────────────────────

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

autoUpdater.on('update-downloaded', info => {
  console.log('   ↳ Update downloaded:', info);
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

autoUpdater.on('error', err => {
  console.error('   ↳ Auto‐updater error:', err);
});

autoUpdater.on('download-progress', progressObj => {
  console.log(`   ↳ Download speed: ${progressObj.bytesPerSecond} — ${Math.round(progressObj.percent)}%`);
});

// ── Check for missing videos ───────────────────────────────────────────
ipcMain.handle('check-missing-videos', async () => {
  console.log('▶ check-missing-videos called; cutoff:', MISSING_SINCE_DATE);
  try {
    const settings = fs.existsSync(settingsPath)
      ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      : {};
    const videoDir = settings.videoPath;
    if (!videoDir || !fs.existsSync(videoDir)) return [];

    const allVids = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'videos.json'), 'utf-8'));
    const recent = allVids.filter(v => v.date && v.date >= MISSING_SINCE_DATE);
    const have = new Set(fs.readdirSync(videoDir).map(f => f.replace(/\.[^/.]+$/, '')));
    const missing = recent
      .map(v => v.filename.split('/').pop().replace(/\.[^/.]+$/, ''))
      .filter(base => !have.has(base));

    console.log('▶ missing-videos:', missing);
    return missing;
  } catch (e) {
    console.error('   ✖ check-missing-videos error:', e);
    return [];
  }
});

// ── Download missing videos from GitHub assets (handles redirects) ───
ipcMain.handle('download-videos', async (event, filenames) => {
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    : {};
  const videoDir = settings.videoPath;
  if (!videoDir || !fs.existsSync(videoDir)) {
    throw new Error('Video folder not set or not found');
  }

  const allVids = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'videos.json'), 'utf-8'));
  const urlMap = {};
  allVids.forEach(v => {
    if (v.downloadUrl) {
      const base = v.filename.split('/').pop().replace(/\.[^/.]+$/, '');
      urlMap[base] = v.downloadUrl;
    }
  });

  async function fetchWithRedirect(url, dest, redirects = 0) {
    if (redirects > 5) throw new Error('Too many redirects');
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      https.get(url, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // follow redirect
          file.close();
          fs.unlink(dest, () => {
            const nextUrl = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, url).toString();
            resolve(fetchWithRedirect(nextUrl, dest, redirects + 1));
          });
        } else if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          reject(new Error(`Failed to download ${path.basename(dest)}: ${res.statusCode}`));
        } else {
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
        }
      }).on('error', err => {
        file.close();
        fs.unlink(dest, () => reject(err));
      });
    });
  }

  await Promise.all(filenames.map(name => {
    const downloadUrl = urlMap[name];
    if (!downloadUrl) {
      return Promise.reject(new Error(`No downloadUrl for ${name}`));
    }
    const urlObj = new URL(downloadUrl);
    const ext = path.extname(urlObj.pathname);
    const dest = path.join(videoDir, `${name}${ext}`);
    return fetchWithRedirect(downloadUrl, dest);
  }));

  return true;
});

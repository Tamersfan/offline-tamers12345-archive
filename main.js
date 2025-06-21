// main.js
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { autoUpdater } = require('electron-updater');

const userData = app.getPath('userData');
const settingsPath = path.join(userData, 'settings.json');
const versionsPath = path.join(userData, 'versions.json');

console.log('▶️  Starting Electron main process');

let win = null;

function createWindow() {
  console.log('   ↳ createWindow() called');
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false // ✅ Allow local subtitle files to load
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

// Utility: load or init a JSON file
function loadJSON(filePath, defaultVal) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) {
    console.error(`Failed to load ${filePath}:`, e);
  }
  return defaultVal;
}
function saveJSON(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error(`Failed to save ${filePath}:`, e);
  }
}

// ── IPC Handlers ───────────────────────────────────────────────────────────
ipcMain.handle('get-settings', async () => {
  return loadJSON(settingsPath, {});
});

ipcMain.handle('select-video-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length) {
    const folderPath = result.filePaths[0];
    saveJSON(settingsPath, { videoPath: folderPath });
    return folderPath;
  }
  return null;
});

ipcMain.handle('read-image-files', async () => {
  const folder = path.join(__dirname, 'deviantart', 'deviantart art framed');
  const files = fs.readdirSync(folder).filter(f => /\.(png|jpe?g|gif)$/i.test(f));
  return files.map(f => ({ filename: f, path: path.join(folder, f) }));
});

ipcMain.handle('read-tumblr-html', async () => {
  const folder = path.join(__dirname, 'tumblr');
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder)
    .filter(f => f.toLowerCase().endsWith('.html'))
    .sort()
    .map(f => path.join('tumblr', f));
});

ipcMain.handle('read-tumblr2-html', async () => {
  const folder = path.join(__dirname, 'tumblr2');
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder)
    .filter(f => f.toLowerCase().endsWith('.html'))
    .sort()
    .map(f => path.join('tumblr2', f));
});

// ── Open external link in user's default browser ─────────────
ipcMain.handle('open-external', async (_event, url) => {
  await shell.openExternal(url);
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
  if (win && win.webContents) {
    win.webContents.send('update-download-progress', progressObj);
  }
});

// ── Check for updated or missing videos ───────────────────────────────────
ipcMain.handle('check-missing-videos', async () => {
  console.log('▶ check-missing-videos called');
  try {
    const settings = loadJSON(settingsPath, {});
    const videoDir = settings.videoPath;
    if (!videoDir || !fs.existsSync(videoDir)) return [];

    // load remote manifest & local version map
    const allVids = loadJSON(path.join(__dirname, 'data', 'videos.json'), []);
    const localVer = loadJSON(versionsPath, {});

    // find files that either don't exist, or have bumped version
    const toFetch = allVids.filter(v => {
      const base = path.basename(v.filename, path.extname(v.filename));
      const remoteV = v.version || 1;
      const haveFile = fs.existsSync(path.join(videoDir, v.filename));
      const localV   = localVer[base] || 1;
      return (!haveFile) || (remoteV > localV);
    }).map(v => v.filename);

    console.log('▶ toFetch:', toFetch);
    return toFetch;
  } catch (e) {
    console.error('   ✖ check-missing-videos error:', e);
    return [];
  }
});

// ── Download videos from GitHub assets & update versions map ─────────────
ipcMain.handle('download-videos', async (event, filenames) => {
  console.log('▶ download-videos:', filenames);
  const settings = loadJSON(settingsPath, {});
  const videoDir = settings.videoPath;
  if (!videoDir || !fs.existsSync(videoDir)) {
    throw new Error('Video folder not set or not found');
  }

  const allVids = loadJSON(path.join(__dirname, 'data', 'videos.json'), []);
  const localVer = loadJSON(versionsPath, {});

  // build map of base→downloadUrl & version
  const map = {};
  allVids.forEach(v => {
    const base = path.basename(v.filename, path.extname(v.filename));
    if (v.downloadUrl) map[base] = { url: v.downloadUrl, version: v.version || 1, filename: v.filename };
  });

  // helper to handle HTTP redirects and send progress
  async function fetchWithRedirectAndProgress(url, dest, onProgress, redirects = 0) {
    if (redirects > 5) throw new Error('Too many redirects');
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      https.get(url, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(dest, () => {
            const next = new URL(res.headers.location, url).toString();
            resolve(fetchWithRedirectAndProgress(next, dest, onProgress, redirects + 1));
          });
        } else if (res.statusCode !== 200) {
          file.close(); fs.unlink(dest, ()=>{});
          reject(new Error(`Failed to download ${path.basename(dest)}: ${res.statusCode}`));
        } else {
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let received = 0;
          res.on('data', chunk => {
            received += chunk.length;
            if (onProgress) onProgress(received, total);
          });
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
        }
      }).on('error', err => {
        file.close(); fs.unlink(dest, ()=>{});
        reject(err);
      });
    });
  }

  // download each and update localVer
  for (const fname of filenames) {
    const base = path.basename(fname, path.extname(fname));
    const entry = map[base];
    if (!entry) throw new Error(`No downloadUrl for ${base}`);
    const dest = path.join(videoDir, entry.filename);

    await fetchWithRedirectAndProgress(entry.url, dest, (received, total) => {
      if (win && win.webContents) {
        win.webContents.send('video-download-progress', {
          filename: entry.filename,
          received,
          total,
          percent: total ? (received / total) * 100 : 0
        });
      }
    });
    localVer[base] = entry.version;
  }

  // save updated versions map
  saveJSON(versionsPath, localVer);

  // Signal completion (final progress 100%)
  if (win && win.webContents) {
    win.webContents.send('video-download-progress', { percent: 100 });
  }
  return true;
});

// ── Alt Video IPC for Renderer (no fs in preload) ─────────────
ipcMain.handle('file-exists', async (_event, fullPath) => {
  try {
    await fs.promises.access(fullPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('save-alt-video', async (_event, fullPath, arrayBuffer) => {
  await fs.promises.writeFile(fullPath, Buffer.from(arrayBuffer));
});

// main.js
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

function getFfmpegPath() {
  // Handles ASAR packaging too
  let binFolder = '';
  let exe = 'ffmpeg';
  switch (process.platform) {
    case 'win32':
      binFolder = 'win';
      exe = 'ffmpeg.exe';
      break;
    case 'darwin':
      binFolder = 'mac';
      break;
    case 'linux':
      binFolder = 'linux';
      break;
  }
  let dir = __dirname;
  // If using ASAR, get path outside asar for binaries
  if (dir.endsWith('.asar')) dir = dir.replace('.asar', '.asar.unpacked');
  return path.join(dir, 'ffmpeg-bin', binFolder, exe);
}

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

// === IPC for GIF creation ===
ipcMain.handle('make-gif', async (event, { inputPath, start, duration, outputPath }) => {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const tmpDir = os.tmpdir();
    const palettePath = path.join(tmpDir, 'palette.png');

    // 1. Generate palette
    const paletteArgs = [
      '-ss', String(start),
      '-t', String(duration),
      '-i', inputPath,
      '-vf', 'fps=15,scale=480:-1:flags=lanczos,palettegen',
      '-y', palettePath
    ];
    const genPalette = spawn(ffmpegPath, paletteArgs);

    genPalette.on('error', reject);

    genPalette.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(palettePath)) {
        return reject(new Error('Failed to generate palette'));
      }

      // 2. Encode GIF with palette
      const gifArgs = [
        '-ss', String(start),
        '-t', String(duration),
        '-i', inputPath,
        '-i', palettePath,
        '-filter_complex', 'fps=15,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse',
        '-y', outputPath
      ];
      const makeGif = spawn(ffmpegPath, gifArgs);

      makeGif.on('error', reject);

      makeGif.on('close', (gifCode) => {
        fs.unlink(palettePath, ()=>{});
        if (gifCode === 0 && fs.existsSync(outputPath)) {
          resolve({ success: true, outputPath });
        } else {
          reject(new Error('GIF encoding failed, code: ' + gifCode));
        }
      });
    });
  });
});

// === IPC to create GIF from frames ===
ipcMain.handle('make-gif-from-frames', async (event, { framePaths, outputPath, fps }) => {
  if (!Array.isArray(framePaths) || !framePaths.length) {
    throw new Error('No frames provided for GIF export.');
  }
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();

    // Create a temp directory, copy the ordered frames with new names.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-export-'));
    framePaths.forEach((src, idx) => {
      const target = path.join(tmpDir, `frame_${String(idx+1).padStart(4,'0')}.png`);
      fs.copyFileSync(src, target);
    });
    const inputPattern = path.join(tmpDir, 'frame_%04d.png');
    const palettePath = path.join(tmpDir, 'palette.png');

    // Palette generation
    const paletteArgs = [
      '-framerate', String(fps || 15),
      '-i', inputPattern,
      '-vf', 'palettegen',
      '-y', palettePath
    ];
    const genPalette = spawn(ffmpegPath, paletteArgs);

    genPalette.on('error', err => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      reject(err);
    });

    genPalette.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(palettePath)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return reject(new Error('Failed to generate palette for frames'));
      }

      // GIF encode with palette
      const gifArgs = [
        '-framerate', String(fps || 15),
        '-i', inputPattern,
        '-i', palettePath,
        '-lavfi', 'paletteuse',
        '-y', outputPath
      ];
      const makeGif = spawn(ffmpegPath, gifArgs);

      makeGif.on('error', err => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        reject(err);
      });
      makeGif.on('close', (gifCode) => {
        fs.unlink(palettePath, ()=>{});
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (gifCode === 0 && fs.existsSync(outputPath)) {
          resolve({ success: true, outputPath });
        } else {
          reject(new Error('GIF encoding from frames failed, code: ' + gifCode));
        }
      });
    });
  });
});

// === IPC for extracting GIF frames ===
const { v4: uuidv4 } = require('uuid');
ipcMain.handle('extract-gif-frames', async (event, { inputPath, start, duration, fps }) => {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const tmpDir = os.tmpdir();
    const outDir = path.join(tmpDir, 'gif-frames-' + uuidv4());
    fs.mkdirSync(outDir, { recursive: true });
    const outputPattern = path.join(outDir, 'frame_%04d.png');

    // Extract frames with ffmpeg
    const args = [
      '-ss', String(start),
      '-t', String(duration),
      '-i', inputPath,
      '-vf', `fps=${fps || 15},scale=480:-1:flags=lanczos`,
      outputPattern
    ];
    const ff = spawn(ffmpegPath, args);

    ff.on('error', reject);

    ff.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('Failed to extract frames, ffmpeg exit code: ' + code));
      }
      fs.readdir(outDir, (err, files) => {
        if (err) return reject(err);
        // Sort PNGs numerically
        const framePaths = files
          .filter(f => f.endsWith('.png'))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map(f => path.join(outDir, f));
        // Read and encode each PNG as a data URL and keep path
        const frames = framePaths.map(fp => {
          try {
            const data = fs.readFileSync(fp);
            const b64 = data.toString('base64');
            return { url: `data:image/png;base64,${b64}`, filePath: fp };
          } catch {
            return null;
          }
        }).filter(Boolean);
        resolve({ success: true, frames });
      });
    });
  });
});

// === Show save dialog (for  GIF and CLIP) ===
ipcMain.handle('show-save-dialog', async (_event, defaultName, format) => {
  let filters;
  if (format === 'webm') {
    filters = [{ name: 'WebM', extensions: ['webm'] }];
  } else if (format === 'mp4') {
    filters = [{ name: 'MP4', extensions: ['mp4'] }];
  } else {
    filters = [{ name: 'GIF', extensions: ['gif'] }];
  }
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save As',
    defaultPath: defaultName || 'clip',
    filters
  });
  return canceled ? null : filePath;
});

// === Clip Export ===
ipcMain.handle('export-clip', async (event, { file, start, duration, format, outputPath }) => {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();

    let args = [
      '-ss', String(start),
      '-i', file,
      '-t', String(duration)
    ];
    if (format === 'mp4') {
      args.push('-c', 'copy', outputPath);
    } else if (format === 'webm') {
      // Use VP9, scale to 480p, no audio
      args.push('-vf', 'scale=-2:480', '-an', '-c:v', 'libvpx-vp9', '-b:v', '1M', outputPath);
    } else {
      return reject(new Error('Unknown format: ' + format));
    }

    const proc = spawn(ffmpegPath, args);
    proc.on('error', reject);

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ success: true, outputPath });
      } else {
        reject(new Error('ffmpeg export failed, code: ' + code));
      }
    });
  });
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

app.whenReady()
  .then(() => {
    console.log('   ↳ app.whenReady resolved');
    createWindow();

    // ── Manual update flow ───────────────────────────────────────────────
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

ipcMain.handle('set-setting', async (_event, key, value) => {
  try {
    let settings = loadJSON(settingsPath, {});
    settings[key] = value;
    saveJSON(settingsPath, settings);
    return true;
  } catch (e) {
    console.error(`Failed to save setting "${key}":`, e);
    return false;
  }
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
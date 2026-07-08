// main.js
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

function getFfmpegPath() {
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
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'ffmpeg-bin', binFolder, exe));
  }

  let dir = __dirname;
  if (dir.endsWith('.asar')) dir = dir.replace('.asar', '.asar.unpacked');
  candidates.push(path.join(dir, 'ffmpeg-bin', binFolder, exe));

  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

const userData = app.getPath('userData');
const settingsPath = path.join(userData, 'settings.json');
const versionsPath = path.join(userData, 'versions.json');
const userPlaylistsPath = path.join(userData, 'user-playlists.json');

console.log('▶️  Starting Electron main process');

let win = null;
let updaterStarted = false;

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

function startAutoUpdater() {
  if (updaterStarted) return;
  updaterStarted = true;

  if (!app.isPackaged) {
    console.log('   -> Skipping update check in development');
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('   -> failed to load electron-updater:', err);
    return;
  }

  autoUpdater.autoDownload = false;

  autoUpdater.on('update-available', info => {
    console.log('   -> Update available:', info);
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
        console.log('   -> User chose to download update');
        autoUpdater.downloadUpdate();
      } else {
        console.log('   -> User postponed the update');
      }
    });
  });

  autoUpdater.on('update-downloaded', info => {
    console.log('   -> Update downloaded:', info);
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
        console.log('   -> Installing update now');
        autoUpdater.quitAndInstall();
      } else {
        console.log('   -> Will install on exit');
      }
    });
  });

  autoUpdater.on('error', err => {
    console.error('   -> Auto-updater error:', err);
  });

  autoUpdater.on('download-progress', progressObj => {
    console.log(`   -> Download speed: ${progressObj.bytesPerSecond} - ${Math.round(progressObj.percent)}%`);
    if (win && win.webContents) {
      win.webContents.send('update-download-progress', progressObj);
    }
  });

  console.log('   -> Checking for updates...');
  autoUpdater.checkForUpdates().catch(err => {
    console.error('   -> Auto-updater check failed:', err);
  });
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
ipcMain.handle('extract-gif-frames', async (event, { inputPath, start, duration, fps }) => {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-frames-'));
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

ipcMain.handle('export-user-playlist', async (_event, { playlist, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export Playlist',
    defaultPath: defaultName || 'playlist.playlist',
    filters: [
      { name: 'Tamers Playlist', extensions: ['playlist'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  });
  if (canceled || !filePath) return null;

  const finalPath = /\.(playlist|json)$/i.test(filePath) ? filePath : `${filePath}.playlist`;
  fs.writeFileSync(finalPath, JSON.stringify(playlist, null, 2), 'utf-8');
  return finalPath;
});

ipcMain.handle('import-user-playlist', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Import Playlist',
    properties: ['openFile'],
    filters: [
      { name: 'Tamers Playlist', extensions: ['playlist'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  });
  if (canceled || !filePaths.length) return null;

  const filePath = filePaths[0];
  const text = fs.readFileSync(filePath, 'utf-8');
  return {
    filePath,
    playlist: JSON.parse(text)
  };
});

// === Clip Export ===
ipcMain.handle('export-clip', async (event, { file, start, duration, format, outputPath }) => {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();

    if (!file || !outputPath) {
      return reject(new Error('Missing input or output path.'));
    }
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
      return reject(new Error('Invalid clip time range.'));
    }

    let args = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-ss', String(start),
      '-i', file,
      '-t', String(duration),
      '-map', '0:v:0',
      '-sn',
      '-dn',
      '-map_metadata', '-1',
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
      '-max_muxing_queue_size', '4096'
    ];
    if (format === 'mp4') {
      args.push(
        '-map', '0:a:0?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+faststart',
        outputPath
      );
    } else if (format === 'webm') {
      args.push(
        '-vf', 'scale=-2:480',
        '-an',
        '-c:v', 'libvpx-vp9',
        '-b:v', '1M',
        '-deadline', 'good',
        '-cpu-used', '4',
        '-row-mt', '1',
        '-pix_fmt', 'yuv420p',
        outputPath
      );
    } else {
      return reject(new Error('Unknown format: ' + format));
    }

    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.on('error', reject);
    proc.stderr?.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ success: true, outputPath });
      } else {
        reject(new Error(`ffmpeg export failed, code: ${code}${stderr ? `\n${stderr.trim()}` : ''}`));
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

const DOWNLOADABLE_VIDEO_EXTENSIONS = ['.mp4', '.webm'];
const WINDOWS_FILENAME_REPLACEMENTS = {
  '<': '‹',
  '>': '›',
  ':': '：',
  '"': '＂',
  '/': '／',
  '\\': '＼',
  '|': '｜',
  '?': '？',
  '*': '＊'
};

function sanitizeVideoFilename(filename) {
  const parsed = path.parse(path.basename(String(filename || 'video.mp4')));
  const cleanPart = part => String(part || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ch => WINDOWS_FILENAME_REPLACEMENTS[ch] || '-');
  const base = cleanPart(parsed.name) || 'video';
  const ext = cleanPart(parsed.ext) || '.mp4';
  const safe = `${base}${ext}`.replace(/[. ]+$/g, '').trim();
  return safe || 'video.mp4';
}

function getVideoDownloadTempPath(videoDir, filename) {
  const parsed = path.parse(sanitizeVideoFilename(filename));
  const base = (parsed.name || 'video').slice(0, 120);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempDir = path.join(videoDir, '.offline-tamers-downloads');
  fs.mkdirSync(tempDir, { recursive: true });
  return path.join(tempDir, `${base}-${token}${parsed.ext}.download`);
}

function moveDownloadedVideo(tempDest, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  try {
    fs.renameSync(tempDest, dest);
  } catch (err) {
    if (!err || !['EXDEV', 'EPERM'].includes(err.code)) throw err;
    fs.copyFileSync(tempDest, dest);
    fs.unlinkSync(tempDest);
  }
}

function getVideoDownloadFileError(err, dest) {
  if (err && ['EPERM', 'EACCES', 'ENOENT'].includes(err.code)) {
    return new Error(
      `Windows could not write the downloaded video to "${dest}". ` +
      'Make sure the video folder is writable and this app is allowed to write there. ' +
      `Original error: ${err.code}`
    );
  }
  return err;
}

function getVideoVersionKey(filename) {
  return path.basename(String(filename || ''), path.extname(String(filename || '')));
}

function fileExistsAsFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getSupersededVideoFilenames(filename, previousFilenames = []) {
  const safeFilename = sanitizeVideoFilename(filename);
  const parsed = path.parse(safeFilename);
  const currentName = path.basename(safeFilename);
  const candidates = new Set(
    Array.isArray(previousFilenames)
      ? previousFilenames.map(f => sanitizeVideoFilename(f)).filter(Boolean)
      : []
  );

  for (const ext of DOWNLOADABLE_VIDEO_EXTENSIONS) {
    candidates.add(`${parsed.name}${ext}`);
  }

  candidates.delete(currentName);
  return [...candidates];
}

function removeSupersededVideoFiles(videoDir, filename, previousFilenames = []) {
  const removed = [];
  for (const oldFilename of getSupersededVideoFilenames(filename, previousFilenames)) {
    const oldPath = path.join(videoDir, oldFilename);
    try {
      if (fileExistsAsFile(oldPath)) {
        fs.unlinkSync(oldPath);
        removed.push(oldFilename);
      }
    } catch (e) {
      console.warn(`Could not remove replaced video "${oldFilename}":`, e);
    }
  }
  return removed;
}

function getHttpClient(url) {
  return new URL(url).protocol === 'http:' ? http : https;
}

function sanitizeScreenshotFilename(filename) {
  const parsed = path.parse(String(filename || 'screenshot.png'));
  const base = (parsed.name || 'screenshot')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180) || 'screenshot';
  return `${base}.png`;
}

function getUniqueFilePath(folder, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(folder, filename);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(folder, `${parsed.name} (${counter})${parsed.ext}`);
    counter += 1;
  }
  return candidate;
}

function getPngBuffer(pngData) {
  if (Buffer.isBuffer(pngData)) return pngData;
  if (pngData instanceof ArrayBuffer) return Buffer.from(pngData);
  if (ArrayBuffer.isView(pngData)) {
    return Buffer.from(pngData.buffer, pngData.byteOffset, pngData.byteLength);
  }
  if (typeof pngData === 'string') {
    const match = pngData.match(/^data:image\/png;base64,(.+)$/);
    if (match) return Buffer.from(match[1], 'base64');
  }
  throw new Error('Invalid screenshot data.');
}

function readImageDimensions(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(128 * 1024);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    const buf = header.subarray(0, bytesRead);

    if (buf.length >= 24 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset += 1;
          continue;
        }

        const marker = buf[offset + 1];
        offset += 2;
        if (marker === 0xd8 || marker === 0xd9) continue;
        if (offset + 2 > buf.length) break;

        const length = buf.readUInt16BE(offset);
        if (length < 2 || offset + length > buf.length) break;

        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return {
            height: buf.readUInt16BE(offset + 3),
            width: buf.readUInt16BE(offset + 5)
          };
        }

        offset += length;
      }
    }
  } catch (e) {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  return {};
}

app.whenReady()
  .then(() => {
    console.log('   ↳ app.whenReady resolved');
    createWindow();
    setTimeout(startAutoUpdater, 5000);
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

ipcMain.handle('get-downloads-path', async () => {
  return app.getPath('downloads');
});

ipcMain.handle('get-user-playlists', async () => {
  return {
    exists: fs.existsSync(userPlaylistsPath),
    playlists: loadJSON(userPlaylistsPath, [])
  };
});

ipcMain.handle('save-user-playlists', async (_event, playlists) => {
  if (!Array.isArray(playlists)) {
    throw new Error('Invalid playlist data.');
  }
  saveJSON(userPlaylistsPath, playlists);
  return { success: true };
});

ipcMain.handle('select-video-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length) {
    const folderPath = result.filePaths[0];
    const settings = loadJSON(settingsPath, {});
    saveJSON(settingsPath, { ...settings, videoPath: folderPath });
    return folderPath;
  }
  return null;
});

ipcMain.handle('select-screenshot-folder', async (_event, currentPath) => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Screenshot Folder',
    defaultPath: currentPath || app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (!result.canceled && result.filePaths.length) {
    const folderPath = result.filePaths[0];
    const settings = loadJSON(settingsPath, {});
    saveJSON(settingsPath, { ...settings, screenshotFolder: folderPath });
    return folderPath;
  }
  return null;
});

ipcMain.handle('save-screenshot', async (_event, { filename, pngData }) => {
  const settings = loadJSON(settingsPath, {});
  const safeFilename = sanitizeScreenshotFilename(filename);
  const defaultFolder = app.getPath('downloads');
  const screenshotFolder = settings.screenshotFolder || defaultFolder;
  const buffer = getPngBuffer(pngData);

  if (settings.screenshotPromptEachTime) {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save Screenshot',
      defaultPath: path.join(screenshotFolder, safeFilename),
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    });
    if (canceled || !filePath) return { success: false, canceled: true };

    const finalPath = /\.png$/i.test(filePath) ? filePath : `${filePath}.png`;
    fs.writeFileSync(finalPath, buffer);
    return { success: true, filePath: finalPath };
  }

  fs.mkdirSync(screenshotFolder, { recursive: true });
  const filePath = getUniqueFilePath(screenshotFolder, safeFilename);
  fs.writeFileSync(filePath, buffer);
  return { success: true, filePath };
});

ipcMain.handle('read-archive-json', async (_event, folder, filename) => {
  const allowedFolders = new Set(['comments', 'metadata']);
  if (!allowedFolders.has(folder)) return null;

  const baseDir = path.join(__dirname, folder);
  const filePath = path.resolve(baseDir, String(filename || ''));
  if (!filePath.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid archive JSON path.');
  }
  if (!fs.existsSync(filePath)) return null;

  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
});

ipcMain.handle('read-image-files', async () => {
  const folder = path.join(__dirname, 'deviantart', 'deviantart art framed');
  const files = fs.readdirSync(folder).filter(f => /\.(png|jpe?g|gif)$/i.test(f));
  return files.map(f => {
    const filePath = path.join(folder, f);
    const stat = fs.statSync(filePath);
    return {
      filename: f,
      path: filePath,
      size: stat.size,
      ...readImageDimensions(filePath)
    };
  });
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

ipcMain.handle('read-posts-data', async () => {
  try {
    const base = path.join(__dirname, 'posts');
    if (!fs.existsSync(base)) return [];

    const channelDirs = fs.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory());

    const items = [];
    for (const channelDir of channelDirs) {
      const channelId = channelDir.name;
      let indexIds = [];
      try {
        const indexPath = path.join(base, channelId, '_index.json');
        if (fs.existsSync(indexPath)) {
          const indexJson = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          if (Array.isArray(indexJson.posts)) {
            indexIds = indexJson.posts.map(p => p.id).filter(Boolean);
          }
        }
      } catch (e) {
        console.warn('Failed to read post index for channel:', channelId, e);
      }

      const postsDir = path.join(base, channelId, 'posts');
      if (!fs.existsSync(postsDir)) continue;

      const postFolders = fs.readdirSync(postsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      const channelItems = [];
      const missingJsonFolders = [];
      const knownIds = new Set();

      for (const folderDir of postFolders) {
        const folderName = folderDir.name;
        const folderPath = path.join(postsDir, folderName);

        let json = null;
        let jsonFilename = null;
        const jsonFiles = fs.readdirSync(folderPath)
          .filter(f => f.toLowerCase().endsWith('.json'));
        if (jsonFiles.length) {
          jsonFilename = jsonFiles[0];
          const jsonPath = path.join(folderPath, jsonFilename);
          try {
            json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          } catch (e) {
            console.error('Failed to parse post JSON:', jsonPath, e);
          }
        }

        const mediaDir = path.join(folderPath, 'media');
        let mediaFiles = [];
        if (fs.existsSync(mediaDir)) {
          mediaFiles = fs.readdirSync(mediaDir)
            .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
            .map(f => ({
              filename: f,
              url: pathToFileURL(path.join(mediaDir, f)).toString()
            }));
        }

        let postId = (json && json.post && json.post.id)
          ? json.post.id
          : (jsonFilename ? path.parse(jsonFilename).name : null);

        if (!postId && indexIds.length) {
          const bracket = folderName.match(/\[([A-Za-z0-9_-]{6,})\]/);
          if (bracket) {
            const prefix = bracket[1];
            const matchId = indexIds.find(id => id.startsWith(prefix));
            if (matchId) postId = matchId;
          }
        }
        if (postId) knownIds.add(postId);

        const entry = {
          channelId,
          folderName,
          postId,
          json,
          mediaFiles
        };
        channelItems.push(entry);
        if (!jsonFilename) missingJsonFolders.push(entry);
      }

      if (indexIds.length && missingJsonFolders.length) {
        const missingIds = indexIds.filter(id => !knownIds.has(id));
        if (missingIds.length === missingJsonFolders.length) {
          missingJsonFolders.sort((a, b) => a.folderName.localeCompare(b.folderName, undefined, { sensitivity: 'base' }));
          missingJsonFolders.forEach((entry, idx) => {
            entry.postId = missingIds[idx] || entry.postId;
          });
        }
      }

      items.push(...channelItems);
    }

    return items;
  } catch (e) {
    console.error('read-posts-data failed:', e);
    return [];
  }
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

    // Find downloadable files that are truly missing. If the current file is
    // already in the selected folder, trust it and bring the local version
    // marker forward. Previous filenames still trigger a fresh download so
    // users with old copies get the newer replacement.
    const seen = new Set();
    let versionsChanged = false;
    const toFetch = [];
    for (const v of allVids) {
      if (!v.downloadUrl) continue;
      const base = getVideoVersionKey(v.filename);
      if (seen.has(base)) continue;
      const safeFilename = sanitizeVideoFilename(v.filename);
      const remoteV = v.version || 1;
      const currentPath = path.join(videoDir, safeFilename);
      const haveFile = fileExistsAsFile(currentPath);
      const hasLocalVersion = Object.prototype.hasOwnProperty.call(localVer, base);
      const localV = hasLocalVersion ? localVer[base] : 1;

      if (haveFile) {
        if (remoteV > localV) {
          seen.add(base);
          toFetch.push(v.filename);
          continue;
        }
        if (!hasLocalVersion || localVer[base] !== remoteV) {
          localVer[base] = remoteV;
          versionsChanged = true;
        }
        seen.add(base);
        continue;
      }

      seen.add(base);
      toFetch.push(v.filename);
    }

    if (versionsChanged) saveJSON(versionsPath, localVer);

    console.log('▶ toFetch:', toFetch);
    return toFetch;
  } catch (e) {
    console.error('   ✖ check-missing-videos error:', e);
    return [];
  }
});

// ── Download videos from remote assets & update versions map ─────────────
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
    const base = getVideoVersionKey(v.filename);
    if (v.downloadUrl) {
      const entry = {
        url: v.downloadUrl,
        version: v.version || 1,
        filename: sanitizeVideoFilename(v.filename),
        previousFilenames: v.previousFilenames || []
      };
      map[base] = entry;
      map[getVideoVersionKey(entry.filename)] = entry;
    }
  });

  // helper to handle HTTP redirects and send progress
  async function fetchWithRedirectAndProgress(url, dest, onProgress, redirects = 0) {
    if (redirects > 5) throw new Error('Too many redirects');
    return new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let file;
      let settled = false;
      const fail = err => {
        if (settled) return;
        settled = true;
        if (file) file.destroy();
        fs.unlink(dest, () => reject(err));
      };

      try {
        file = fs.createWriteStream(dest);
        file.on('error', fail);
      } catch (err) {
        fail(err);
        return;
      }

      const req = getHttpClient(url).get(url, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          file.close(() => {
            fs.unlink(dest, () => {});
            const next = new URL(res.headers.location, url).toString();
            resolve(fetchWithRedirectAndProgress(next, dest, onProgress, redirects + 1));
          });
        } else if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`Failed to download ${path.basename(dest)}: ${res.statusCode}`));
        } else {
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let received = 0;
          res.on('data', chunk => {
            received += chunk.length;
            if (onProgress) onProgress(received, total);
          });
          res.pipe(file);
          res.on('error', fail);
          file.on('finish', () => {
            file.close(() => {
              if (settled) return;
              settled = true;
              resolve();
            });
          });
        }
      });
      req.on('error', fail);
    });
  }

  // download each and update localVer
  const totalVideos = filenames.length;
  for (let index = 0; index < filenames.length; index += 1) {
    const fname = filenames[index];
    const base = getVideoVersionKey(fname);
    const entry = map[base];
    if (!entry) throw new Error(`No downloadUrl for ${base}`);
    const dest = path.join(videoDir, entry.filename);
    const tempDest = getVideoDownloadTempPath(videoDir, entry.filename);
    const current = index + 1;
    const completed = index;

    try {
      await fetchWithRedirectAndProgress(entry.url, tempDest, (received, total) => {
        if (win && win.webContents) {
          win.webContents.send('video-download-progress', {
            filename: entry.filename,
            received,
            total,
            percent: total ? (received / total) * 100 : 0,
            current,
            completed,
            totalVideos
          });
        }
      });

      const downloaded = fs.statSync(tempDest);
      if (!downloaded.size) {
        throw new Error(`Downloaded file was empty: ${entry.filename}`);
      }

      moveDownloadedVideo(tempDest, dest);
      const removed = removeSupersededVideoFiles(videoDir, entry.filename, entry.previousFilenames);
      if (removed.length) {
        console.log('   -> Removed replaced video files:', removed);
      }
      localVer[base] = entry.version;
      saveJSON(versionsPath, localVer);
      if (win && win.webContents) {
        win.webContents.send('video-download-progress', {
          filename: entry.filename,
          received: downloaded.size,
          total: downloaded.size,
          percent: 100,
          current,
          completed: current,
          totalVideos
        });
      }
    } catch (e) {
      try { if (fs.existsSync(tempDest)) fs.unlinkSync(tempDest); } catch {}
      throw getVideoDownloadFileError(e, dest);
    }
  }

  // save updated versions map
  saveJSON(versionsPath, localVer);

  // Signal completion (final progress 100%)
  if (win && win.webContents) {
    win.webContents.send('video-download-progress', {
      percent: 100,
      completed: totalVideos,
      totalVideos,
      done: true
    });
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

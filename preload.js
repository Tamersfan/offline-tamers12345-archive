// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings:         () => ipcRenderer.invoke('get-settings'),
  setSetting:          (key, value) => ipcRenderer.invoke('set-setting', key, value),
  selectVideoFolder:   () => ipcRenderer.invoke('select-video-folder'),
  readImageFiles:      () => ipcRenderer.invoke('read-image-files'),
  readTumblrHTML:      () => ipcRenderer.invoke('read-tumblr-html'),
  readTumblr2HTML:     () => ipcRenderer.invoke('read-tumblr2-html'),
  checkMissingVideos:  () => ipcRenderer.invoke('check-missing-videos'),
  downloadVideos:      (filenames) => ipcRenderer.invoke('download-videos', filenames),

  // Alt video helpers via IPC
  fileExists:          (fullPath) => ipcRenderer.invoke('file-exists', fullPath),
  saveAltVideo:        (fullPath, arrayBuffer) => ipcRenderer.invoke('save-alt-video', fullPath, arrayBuffer),
  readFile: (fullPath) => ipcRenderer.invoke('read-file', fullPath),

  // Listen for update and video download progress
  onUpdateProgress:    (callback) => ipcRenderer.on('update-download-progress', (_event, progress) => callback(progress)),
  onVideoDownloadProgress: (callback) => ipcRenderer.on('video-download-progress', (_event, data) => callback(data)),

  // Open external links in user's default browser (for credits, etc.)
  openExternal:        (url) => ipcRenderer.invoke('open-external', url),

  // ffmpeg make gifs (from video or original frames)
  makeGif:             (params) => ipcRenderer.invoke('make-gif', params),

  // Export GIF from a custom list of PNG frame file paths (after frame deletes)
  makeGifFromFrames:   (opts) => ipcRenderer.invoke('make-gif-from-frames', opts),

  // Extract frames for GIF preview (returns array of {url, filePath})
  extractGifFrames:    async (opts) => {
    const res = await ipcRenderer.invoke('extract-gif-frames', opts);
    if (!res.success || !Array.isArray(res.frames)) return [];
    return res.frames;
  },

  showSaveDialog:      (defaultPath) => ipcRenderer.invoke('show-save-dialog', defaultPath),

  // Export video clip
  exportClip:          (opts) => ipcRenderer.invoke('export-clip', opts)
});

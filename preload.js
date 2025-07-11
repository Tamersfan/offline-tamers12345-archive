// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings:         () => ipcRenderer.invoke('get-settings'),
  setSetting:          (key, value) => ipcRenderer.invoke('set-setting', key, value),
  selectVideoFolder:   () => ipcRenderer.invoke('select-video-folder'),
  readImageFiles:      () => ipcRenderer.invoke('read-image-files'),
  readTumblrHTML:      () => ipcRenderer.invoke('read-tumblr-html'),
  readTumblr2HTML:     () => ipcRenderer.invoke('read-tumblr2-html'),
  // Compare videos.json vs. actual files in video folder
  checkMissingVideos:  () => ipcRenderer.invoke('check-missing-videos'),
  // Download an array of missing video filenames from GitHub release assets into the chosen folder
  downloadVideos:      (filenames) => ipcRenderer.invoke('download-videos', filenames),

  // Alt video helpers via IPC
  fileExists:          (fullPath) => ipcRenderer.invoke('file-exists', fullPath),
  saveAltVideo:        (fullPath, arrayBuffer) => ipcRenderer.invoke('save-alt-video', fullPath, arrayBuffer),

  // Listen for update and video download progress
  onUpdateProgress:    (callback) => ipcRenderer.on('update-download-progress', (_event, progress) => callback(progress)),
  onVideoDownloadProgress: (callback) => ipcRenderer.on('video-download-progress', (_event, data) => callback(data)),

  // Open external links in user's default browser (for credits, etc.)
  openExternal:        (url) => ipcRenderer.invoke('open-external', url)
});

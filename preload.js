// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings:         () => ipcRenderer.invoke('get-settings'),
  selectVideoFolder:   () => ipcRenderer.invoke('select-video-folder'),
  readImageFiles:      () => ipcRenderer.invoke('read-image-files'),
  readTumblrHTML:      () => ipcRenderer.invoke('read-tumblr-html'),
  readTumblr2HTML:     () => ipcRenderer.invoke('read-tumblr2-html'),
  // Compare videos.json vs. actual files in video folder
  checkMissingVideos:  () => ipcRenderer.invoke('check-missing-videos'),
  // Download an array of missing video filenames from GitHub release assets into the chosen folder
  downloadVideos:      (filenames) => ipcRenderer.invoke('download-videos', filenames)
});

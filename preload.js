const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings:       () => ipcRenderer.invoke('get-settings'),
  selectVideoFolder: () => ipcRenderer.invoke('select-video-folder'),
  readImageFiles:    () => ipcRenderer.invoke('read-image-files'),
  readTumblrHTML:    () => ipcRenderer.invoke('read-tumblr-html'),
  readTumblr2HTML:   () => ipcRenderer.invoke('read-tumblr2-html')   // ← added
});

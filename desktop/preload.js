const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studio', {
  selectFolder: (defaultPath) => ipcRenderer.invoke('studio:selectFolder', defaultPath),
  selectFile: (options) => ipcRenderer.invoke('studio:selectFile', options),
  openPath: (p) => ipcRenderer.invoke('studio:openPath', p),
  version: () => ipcRenderer.invoke('studio:version'),
})

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  runCommand: (command) => ipcRenderer.invoke('run-system-command', command)
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveToDownloads: (blob) => {
    // Convert blob to base64 and send to main process
    const reader = new FileReader();
    reader.onload = function () {
      ipcRenderer.send('save-audio', reader.result);
    };
    reader.readAsDataURL(blob);
  },
  send: (channel, data) => ipcRenderer.send(channel, data),
  receive: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args))
});

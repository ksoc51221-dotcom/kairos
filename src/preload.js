const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('spool', {
  invoke: (ch, ...a) => ipcRenderer.invoke(ch, ...a),
  send: (ch, ...a) => ipcRenderer.send(ch, ...a),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, ...a) => fn(...a)),
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('filter', {
  load: () => ipcRenderer.invoke('filter:load'),
  toggle: (id) => ipcRenderer.invoke('filter:toggle', id),
  restoreAll: () => ipcRenderer.invoke('filter:restore-all'),
  setRandomMode: (on) => ipcRenderer.invoke('filter:random-mode', on),
  pin: (id) => ipcRenderer.invoke('filter:pin', id),
  preview: (id) => ipcRenderer.invoke('filter:preview', id),
  close: () => ipcRenderer.send('filter:close'),
});

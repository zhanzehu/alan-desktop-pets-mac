'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  init: () => ipcRenderer.invoke('pet:init'),

  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  showMenu: () => ipcRenderer.send('pet:menu'),

  onPlay: (cb) => ipcRenderer.on('pet:play', (_e, data) => cb(data)),
  onStop: (cb) => ipcRenderer.on('pet:stop', () => cb()),
  onCaption: (cb) => ipcRenderer.on('pet:caption', (_e, data) => cb(data)),
  onMotion: (cb) => ipcRenderer.on('pet:motion', (_e, data) => cb(data)),
  onVolume: (cb) => ipcRenderer.on('pet:volume', (_e, data) => cb(data)),

  ended: (id) => ipcRenderer.send('pet:ended', id),
  failed: (id, reason) => ipcRenderer.send('pet:failed', { id, reason }),
});

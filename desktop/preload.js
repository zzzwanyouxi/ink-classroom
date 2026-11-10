'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inkDesktop', {
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke('ws-pick'),
  loadWorkspace: () => ipcRenderer.invoke('ws-load'),
  saveWorkspace: (payload) => ipcRenderer.invoke('ws-save', payload),
  workspaceInfo: () => ipcRenderer.invoke('ws-info'),
  toggleFullScreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  setFullScreen: (value) => ipcRenderer.invoke('set-fullscreen', value),
  onFullScreen: (cb) => {
    ipcRenderer.on('fullscreen-changed', (event, value) => cb(value));
  },
});

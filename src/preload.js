'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appApi', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveConfig: cfg => ipcRenderer.invoke('config:save', cfg),
  reapply: () => ipcRenderer.invoke('app:reapply'),
  testNotify: () => ipcRenderer.invoke('app:test-notify'),
  openLog: () => ipcRenderer.invoke('app:open-log'),
  refreshOccupants: () => ipcRenderer.invoke('occupants:refresh'),
  killPid: (pid, name) => ipcRenderer.invoke('occupants:kill', pid, name),

  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  hide: () => ipcRenderer.send('window:hide'),

  onStateChanged: cb => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  }
});

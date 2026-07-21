const { contextBridge, ipcRenderer, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

const botPatchSource = fs.readFileSync(path.join(__dirname, 'bot-inject.js'), 'utf8');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  fetchShared: (url) => ipcRenderer.invoke('shared:fetch', url),
  musicProxyPort: () => ipcRenderer.invoke('music:proxyPort'),
  musicSearch: (q) => ipcRenderer.invoke('music:search', q),
  ytSearch: (q) => ipcRenderer.invoke('music:ytsearch', q),
  ytUrl: (id) => ipcRenderer.invoke('music:yturl', id),
  appVersion: () => ipcRenderer.invoke('app:version'),
  dbReq: (opts) => ipcRenderer.invoke('db:req', opts),
  downloadUpdate: (url) => ipcRenderer.invoke('update:download', url),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (e, pct) => cb(pct)),
  botPatchSource: () => botPatchSource,
  updateTrayRooms: (rooms) => ipcRenderer.send('rooms:update', rooms),
  readClipboard: () => clipboard.readText(),
  openExternal: (url) => ipcRenderer.send('open:external', url),
  onRoomActivate: (cb) => ipcRenderer.on('room:activate', (e, id) => cb(id)),
  onMuteHotkey: (cb) => ipcRenderer.on('hotkey:mute', () => cb()),
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    miniToggle: () => ipcRenderer.send('win:mini-toggle'),
    onMaximized: (cb) => ipcRenderer.on('win:maximized', (e, v) => cb(v)),
    onMini: (cb) => ipcRenderer.on('win:mini', (e, v) => cb(v))
  }
});

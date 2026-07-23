const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');
const fs = require('fs');
const path = require('path');

const botPatchSource = fs.readFileSync(path.join(__dirname, 'bot-inject.js'), 'utf8');
const voicePatchSource = fs.readFileSync(path.join(__dirname, 'voice-inject.js'), 'utf8');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  fetchShared: (url) => ipcRenderer.invoke('shared:fetch', url),
  musicProxyPort: () => ipcRenderer.invoke('music:proxyPort'),
  musicSearch: (q) => ipcRenderer.invoke('music:search', q),
  songSearch: (q, hint) => ipcRenderer.invoke('music:songsearch', q, hint),
  songUrl: (url) => ipcRenderer.invoke('music:songurl', url),
  appVersion: () => ipcRenderer.invoke('app:version'),
  dbReq: (opts) => ipcRenderer.invoke('db:req', opts),
  downloadUpdate: (url) => ipcRenderer.invoke('update:download', url),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (e, pct) => cb(pct)),
  djModel: (lang) => ipcRenderer.invoke('dj:model', lang),
  sfxList: () => ipcRenderer.invoke('sfx:list'),
  sfxAddFile: (src, name) => ipcRenderer.invoke('sfx:addFile', src, name),
  sfxAddUrl: (url, name) => ipcRenderer.invoke('sfx:addUrl', url, name),
  sfxAddSearch: (q, name) => ipcRenderer.invoke('sfx:addSearch', q, name),
  sfxRemove: (file) => ipcRenderer.invoke('sfx:remove', file),
  ttsSay: (text) => ipcRenderer.invoke('tts:say', text),
  onDjProgress: (cb) => ipcRenderer.on('dj:progress', (e, pct) => cb(pct)),
  botPatchSource: () => botPatchSource,
  voicePatchSource: () => voicePatchSource,
  allowFile: (p) => ipcRenderer.invoke('music:allowFile', p),
  getFilePath: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
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

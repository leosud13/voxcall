import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('voxcall', {
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    getAll: () => ipcRenderer.invoke('store:getAll'),
    reset: () => ipcRenderer.invoke('store:reset'),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  net: {
    latency: (host, port) => ipcRenderer.invoke('net:latency', host, port),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
    setAutoLaunch: (enabled) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
  },
  logo: {
    fetch: (urls, key) => ipcRenderer.invoke('logo:fetch', urls, key),
  },
  call: {
    notifyIncoming: (payload) => ipcRenderer.invoke('call:notify-incoming', payload),
    clearIncoming: () => ipcRenderer.invoke('call:clear-incoming'),
    onAction: (callback) => {
      const handler = (_e, payload) => callback(payload);
      ipcRenderer.on('call:action', handler);
      return () => ipcRenderer.removeListener('call:action', handler);
    },
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (callback) => {
      const handler = (_e, payload) => callback(payload);
      ipcRenderer.on('updater:status', handler);
      return () => ipcRenderer.removeListener('updater:status', handler);
    },
  },
});

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('voxcallAlert', {
  answer: () => ipcRenderer.send('call-alert:answer'),
  reject: () => ipcRenderer.send('call-alert:reject'),
});

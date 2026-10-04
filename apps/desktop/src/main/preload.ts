import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, DesktopAPI, SettingsUpdate } from '../shared/types';

const api: DesktopAPI = {
  snapshot: () => ipcRenderer.invoke('workbench:snapshot'),
  reconnect: () => ipcRenderer.invoke('workbench:reconnect'),
  startProblem: (id: string) => ipcRenderer.invoke('workbench:start', id),
  activateProblem: (id: string) => ipcRenderer.invoke('workbench:activate', id),
  saveCode: (id: string, code: string) => ipcRenderer.invoke('workbench:save', id, code),
  runTests: (submit: boolean) => ipcRenderer.invoke('workbench:run', submit),
  hint: () => ipcRenderer.invoke('workbench:hint'),
  chat: (text: string) => ipcRenderer.invoke('workbench:chat', text),
  cancelChat: () => ipcRenderer.invoke('workbench:cancel'),
  approve: (id: string, allow: boolean) => ipcRenderer.invoke('workbench:approve', id, allow),
  updateSettings: (settings: SettingsUpdate) => ipcRenderer.invoke('workbench:settings', settings),
  chooseCorpus: () => ipcRenderer.invoke('workbench:corpus'),
  exportSolution: () => ipcRenderer.invoke('workbench:export'),
  clearChat: () => ipcRenderer.invoke('workbench:clear-chat'),
  closeReady: (saved: boolean) => ipcRenderer.invoke('workbench:close-ready', saved),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: AppEvent) => callback(event);
    ipcRenderer.on('workbench:event', listener);
    return () => ipcRenderer.removeListener('workbench:event', listener);
  },
};
contextBridge.exposeInMainWorld('interview', api);

import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, DesktopAPI, SettingsUpdate } from '../shared/types';

const api: DesktopAPI = {
  practiceQueue: () => ipcRenderer.invoke('workbench:practice-queue'),
  addPracticeReview: (kind, id, days) =>
    ipcRenderer.invoke('workbench:practice-add', kind, id, days),
  reschedulePracticeReview: (id, days, version) =>
    ipcRenderer.invoke('workbench:practice-reschedule', id, days, version),
  pausePracticeReview: (id, paused, version) =>
    ipcRenderer.invoke('workbench:practice-pause', id, paused, version),
  practiceReflections: (id) => ipcRenderer.invoke('workbench:practice-history', id),
  loadReflectionDraft: (id) => ipcRenderer.invoke('workbench:practice-draft-load', id),
  saveReflectionDraft: (id, draft) =>
    ipcRenderer.invoke('workbench:practice-draft-save', id, draft),
  recordPracticeReflection: (input) => ipcRenderer.invoke('workbench:practice-reflect', input),
  sandboxInfo: () => ipcRenderer.invoke('workbench:sandbox-info'),
  inspectSandbox: () => ipcRenderer.invoke('workbench:sandbox-inspect'),
  enableSandbox: () => ipcRenderer.invoke('workbench:sandbox-enable'),
  stopSandbox: () => ipcRenderer.invoke('workbench:sandbox-stop'),
  licenseNotices: () => ipcRenderer.invoke('workbench:license-notices'),
  updateInfo: () => ipcRenderer.invoke('workbench:update-info'),
  checkUpdates: (channel) => ipcRenderer.invoke('workbench:update-check', channel),
  downloadUpdate: () => ipcRenderer.invoke('workbench:update-download'),
  openUpdateInstaller: () => ipcRenderer.invoke('workbench:update-install'),
  exportWorkspace: () => ipcRenderer.invoke('workbench:export-workspace'),
  installContentPack: () => ipcRenderer.invoke('workbench:install-pack'),
  distributionInfo: () => ipcRenderer.invoke('workbench:distribution-info'),
  openCheckout: () => ipcRenderer.invoke('workbench:checkout'),
  setMode: (mode) => ipcRenderer.invoke('workbench:mode', mode),
  startDesign: (id, fresh) => ipcRenderer.invoke('workbench:design-start', id, fresh ?? false),
  activateDesign: (id) => ipcRenderer.invoke('workbench:design-activate', id),
  loadDesignDraft: (id) => ipcRenderer.invoke('workbench:design-load', id),
  saveDesignDraft: (id, draft) => ipcRenderer.invoke('workbench:design-save', id, draft),
  checkpointDesign: (label) =>
    ipcRenderer.invoke('workbench:design-checkpoint', label ?? 'Checkpoint'),
  designCheckpoints: () => ipcRenderer.invoke('workbench:design-history'),
  restoreDesignCheckpoint: (id) => ipcRenderer.invoke('workbench:design-restore', id),
  reviewDesign: () => ipcRenderer.invoke('workbench:design-review'),
  designHint: () => ipcRenderer.invoke('workbench:design-hint'),
  finishDesign: () => ipcRenderer.invoke('workbench:design-finish'),
  exportDesign: (format, png) => ipcRenderer.invoke('workbench:design-export', format, png),
  snapshot: () => ipcRenderer.invoke('workbench:snapshot'),
  reconnect: () => ipcRenderer.invoke('workbench:reconnect'),
  startProblem: (id: string) => ipcRenderer.invoke('workbench:start', id),
  activateProblem: (id: string) => ipcRenderer.invoke('workbench:activate', id),
  saveCode: (id: string, code: string) => ipcRenderer.invoke('workbench:save', id, code),
  runTests: (submit: boolean) => ipcRenderer.invoke('workbench:run', submit),
  hint: () => ipcRenderer.invoke('workbench:hint'),
  chat: (text: string) => ipcRenderer.invoke('workbench:chat', text),
  grade: () => ipcRenderer.invoke('workbench:grade'),
  cancelChat: (chatId) => ipcRenderer.invoke('workbench:cancel', chatId),
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

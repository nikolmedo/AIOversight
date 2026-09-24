import { contextBridge, ipcRenderer } from 'electron';
import { BucketPref } from '../main/connectors/types';

const api = {
  getInitial: () => ipcRenderer.invoke('settings:get'),
  setConnectorEnabled: (
    id: string,
    enabled: { notifications?: boolean; quota?: boolean },
  ) => ipcRenderer.invoke('connectors:setEnabled', id, enabled),
  setConnectorConfig: (id: string, config: Record<string, unknown>) =>
    ipcRenderer.invoke('connectors:setConfig', id, config),
  setConnectorSecret: (id: string, key: string, value: string | null) =>
    ipcRenderer.invoke('connectors:setSecret', id, key, value),
  setConnectorPollOverride: (id: string, minutes: number | null) =>
    ipcRenderer.invoke('connectors:setPollOverride', id, minutes),
  setConnectorBucketPref: (id: string, bucketId: string, patch: Partial<BucketPref>) =>
    ipcRenderer.invoke('connectors:setBucketPref', id, bucketId, patch),
  setPopupShortcut: (accelerator: string) =>
    ipcRenderer.invoke('settings:setPopupShortcut', accelerator),
  suspendPopupShortcut: (suspend: boolean) =>
    ipcRenderer.invoke('settings:suspendPopupShortcut', suspend),
  update: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:update', patch),
  clearEvents: () => ipcRenderer.invoke('settings:clearEvents'),
  togglePause: () => ipcRenderer.invoke('settings:togglePause'),
  testNotification: () => ipcRenderer.invoke('settings:testNotification'),
  logs: () => ipcRenderer.invoke('settings:logs'),
  getQuotas: () => ipcRenderer.invoke('quota:get'),
  refreshQuota: (id?: string) => ipcRenderer.invoke('quota:refresh', id),
  connectorLogin: (id: string) => ipcRenderer.invoke(`connector:login:${id}`),
  getUpdateState: () => ipcRenderer.invoke('updates:get'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  openRelease: () => ipcRenderer.invoke('updates:openRelease'),
  dismissUpdate: () => ipcRenderer.invoke('updates:dismiss'),
  onEvent: (cb: (e: unknown) => void) => {
    const listener = (_: unknown, e: unknown) => cb(e);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
  onLog: (cb: (e: unknown) => void) => {
    const listener = (_: unknown, e: unknown) => cb(e);
    ipcRenderer.on('log', listener);
    return () => ipcRenderer.removeListener('log', listener);
  },
  onPaused: (cb: (paused: boolean) => void) => {
    const listener = (_: unknown, p: boolean) => cb(p);
    ipcRenderer.on('paused', listener);
    return () => ipcRenderer.removeListener('paused', listener);
  },
  onUpdateState: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on('updates:state', listener);
    return () => ipcRenderer.removeListener('updates:state', listener);
  },
  onQuotaUpdate: (cb: (e: { id: string; snapshot: unknown }) => void) => {
    const listener = (_: unknown, e: { id: string; snapshot: unknown }) => cb(e);
    ipcRenderer.on('quota:update', listener);
    return () => ipcRenderer.removeListener('quota:update', listener);
  },
};

contextBridge.exposeInMainWorld('aw', api);
export type AgentWatcherAPI = typeof api;

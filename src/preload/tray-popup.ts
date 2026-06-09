import { contextBridge, ipcRenderer } from 'electron';
import { QuotaSnapshot, ConnectorMetadata } from '../main/connectors/types';

contextBridge.exposeInMainWorld('awPopup', {
  getQuotas: () =>
    ipcRenderer.invoke('trayPopup:getQuotas') as Promise<Record<string, QuotaSnapshot>>,
  getConnectors: () =>
    ipcRenderer.invoke('trayPopup:getConnectors') as Promise<ConnectorMetadata[]>,
  openSettings: () => ipcRenderer.invoke('trayPopup:openSettings'),
  refresh: () => ipcRenderer.invoke('trayPopup:refresh'),
  onQuotas: (cb: (q: Record<string, QuotaSnapshot>) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, q: Record<string, QuotaSnapshot>) => cb(q);
    ipcRenderer.on('trayPopup:quotas', listener);
    return () => ipcRenderer.removeListener('trayPopup:quotas', listener);
  },
  resize: (height: number) => ipcRenderer.send('trayPopup:resize', height),
  onVisibilityChange: (cb: (visible: boolean) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, visible: boolean) => cb(visible);
    ipcRenderer.on('trayPopup:visibility', listener);
    return () => ipcRenderer.removeListener('trayPopup:visibility', listener);
  },
});

import { contextBridge, ipcRenderer } from 'electron';

type TrayPopupQuotas = Record<string, unknown>;
type TrayPopupConnectors = Array<Record<string, unknown>>;

contextBridge.exposeInMainWorld('awPopup', {
  getQuotas: () => ipcRenderer.invoke('trayPopup:getQuotas') as Promise<TrayPopupQuotas>,
  getConnectors: () =>
    ipcRenderer.invoke('trayPopup:getConnectors') as Promise<TrayPopupConnectors>,
  openSettings: () => ipcRenderer.invoke('trayPopup:openSettings'),
  refresh: () => ipcRenderer.invoke('trayPopup:refresh'),
  onQuotas: (cb: (q: TrayPopupQuotas) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, q: TrayPopupQuotas) => cb(q);
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

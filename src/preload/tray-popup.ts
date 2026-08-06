import { contextBridge, ipcRenderer } from 'electron';
import { QuotaSnapshot, ConnectorMetadata, BucketPref } from '../main/connectors/types';

interface TrayPopupUiPrefs {
  theme: 'system' | 'light' | 'dark';
  density: 'default' | 'compact';
  timeFormat: 'auto' | '12h' | '24h';
  transparentPopup: boolean;
  showSpendCard: boolean;
}

contextBridge.exposeInMainWorld('awPopup', {
  getQuotas: () =>
    ipcRenderer.invoke('trayPopup:getQuotas') as Promise<Record<string, QuotaSnapshot>>,
  getConnectors: () =>
    ipcRenderer.invoke('trayPopup:getConnectors') as Promise<ConnectorMetadata[]>,
  getBucketPrefs: () =>
    ipcRenderer.invoke('trayPopup:getBucketPrefs') as Promise<Record<string, Record<string, BucketPref>>>,
  getUiPrefs: () => ipcRenderer.invoke('trayPopup:getUiPrefs') as Promise<TrayPopupUiPrefs>,
  openSettings: () => ipcRenderer.invoke('trayPopup:openSettings'),
  /** Omit `id` to refresh every enabled connector; passing `id` resolves to
   * `{ [id]: snapshot }`, not the full map — see tray-popup.ts's caller. */
  refresh: (id?: string) =>
    ipcRenderer.invoke('trayPopup:refresh', id) as Promise<Record<string, QuotaSnapshot>>,
  /** Returns just the `bucketPrefs` slice (matching `getBucketPrefs`'s shape),
   * not the full `AppSettings` — the popup only ever reads this back out. */
  setBucketPref: (connectorId: string, bucketId: string, patch: Partial<BucketPref>) =>
    ipcRenderer.invoke('trayPopup:setBucketPref', connectorId, bucketId, patch) as Promise<
      Record<string, Record<string, BucketPref>>
    >,
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

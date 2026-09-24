import { contextBridge, ipcRenderer } from 'electron';
import { QuotaSnapshot, ConnectorMetadata, BucketPref } from '../main/connectors/types';
import type { UpdateState } from '../main/updater';

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
  /** Effective poll interval in ms per polled connector; hand-refresh-only
   * connectors are absent. */
  getPollIntervals: () =>
    ipcRenderer.invoke('trayPopup:getPollIntervals') as Promise<Record<string, number>>,
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
  getUpdateState: () => ipcRenderer.invoke('trayPopup:getUpdateState') as Promise<UpdateState>,
  downloadUpdate: () => ipcRenderer.invoke('trayPopup:downloadUpdate') as Promise<UpdateState>,
  installUpdate: () => ipcRenderer.invoke('trayPopup:installUpdate'),
  openRelease: () => ipcRenderer.invoke('trayPopup:openRelease'),
  dismissUpdate: () => ipcRenderer.invoke('trayPopup:dismissUpdate') as Promise<UpdateState>,
  onUpdateState: (cb: (state: UpdateState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: UpdateState) => cb(state);
    ipcRenderer.on('trayPopup:updateState', listener);
    return () => ipcRenderer.removeListener('trayPopup:updateState', listener);
  },
  onQuotas: (cb: (q: Record<string, QuotaSnapshot>) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, q: Record<string, QuotaSnapshot>) => cb(q);
    ipcRenderer.on('trayPopup:quotas', listener);
    return () => ipcRenderer.removeListener('trayPopup:quotas', listener);
  },
  resize: (height: number) => ipcRenderer.send('trayPopup:resize', height),
  hide: () => ipcRenderer.send('trayPopup:hide'),
  onVisibilityChange: (cb: (visible: boolean) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, visible: boolean) => cb(visible);
    ipcRenderer.on('trayPopup:visibility', listener);
    return () => ipcRenderer.removeListener('trayPopup:visibility', listener);
  },
});

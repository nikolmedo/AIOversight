// QuotaBucket / QuotaSnapshot / ConnectorMetadata / AppSettings live in `quota-types.d.ts`.

/** Subset of `AppSettings` the tray popup needs applied to its own document
 * (theme/density affect it via CSS the same as the settings window; the
 * popup has no settings-window-style `renderGeneral` to read the rest from). */
interface TrayPopupUiPrefs {
  theme: 'system' | 'light' | 'dark';
  density: 'default' | 'compact';
  timeFormat: 'auto' | '12h' | '24h';
  transparentPopup: boolean;
  showSpendCard: boolean;
}

interface TrayPopupAPI {
  getQuotas(): Promise<Record<string, QuotaSnapshot>>;
  getConnectors(): Promise<ConnectorMetadata[]>;
  getBucketPrefs(): Promise<Record<string, Record<string, BucketPref>>>;
  getUiPrefs(): Promise<TrayPopupUiPrefs>;
  /** Effective poll interval in ms per polled connector; connectors that only
   * refresh by hand are absent. */
  getPollIntervals(): Promise<Record<string, number>>;
  openSettings(): Promise<void>;
  refresh(id?: string): Promise<Record<string, QuotaSnapshot>>;
  /** Returns just the `bucketPrefs` slice (matching `getBucketPrefs`'s shape),
   * not the full `AppSettings`. */
  setBucketPref(
    connectorId: string,
    bucketId: string,
    patch: Partial<BucketPref>,
  ): Promise<Record<string, Record<string, BucketPref>>>;
  getUpdateState(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  openRelease(): Promise<void>;
  dismissUpdate(): Promise<UpdateState>;
  onUpdateState(cb: (state: UpdateState) => void): () => void;
  onQuotas(cb: (q: Record<string, QuotaSnapshot>) => void): () => void;
  onVisibilityChange(cb: (visible: boolean) => void): () => void;
  resize(height: number): void;
  /** Hides the popup window (Escape with no row menu open). */
  hide(): void;
}

interface Window {
  awPopup: TrayPopupAPI;
}

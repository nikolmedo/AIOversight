interface QuotaBucket {
  id: string;
  label: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  unit: 'credits' | 'requests' | 'usd';
  enabled: boolean;
}

type QuotaSnapshot =
  | {
      ok: true;
      fetchedAt: number;
      buckets: QuotaBucket[];
      membershipType?: string;
      limitType?: string;
      billingCycleStart?: string;
      billingCycleEnd?: string;
      displayMessages: string[];
      authMethod?: string;
      trayLine?: string;
      source?: string;
    }
  | {
      ok: false;
      fetchedAt: number;
      error: string;
      source?: string;
    };

interface ConnectorMetadata {
  id: string;
  name: string;
  vendor: string;
  description: string;
  hasDetector: boolean;
  hasQuota: boolean;
}

interface TrayPopupAPI {
  getQuotas(): Promise<Record<string, QuotaSnapshot>>;
  getConnectors(): Promise<ConnectorMetadata[]>;
  openSettings(): Promise<void>;
  refresh(): Promise<Record<string, QuotaSnapshot>>;
  onQuotas(cb: (q: Record<string, QuotaSnapshot>) => void): () => void;
  onVisibilityChange(cb: (visible: boolean) => void): () => void;
  resize(height: number): void;
}

interface Window {
  awPopup: TrayPopupAPI;
}

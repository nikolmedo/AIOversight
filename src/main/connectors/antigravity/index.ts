import { Connector } from '../types';
import { createAntigravityQuotaProvider, DEFAULT_PORT_RANGE } from './quota';

const AntigravityConnector: Connector = {
  id: 'antigravity',
  name: 'Antigravity',
  vendor: 'Google',
  description:
    'Off by default: unlike every other connector here, this one only works while the Antigravity app is ' +
    'open on this machine — it scans a small local port range for the running language server and reads ' +
    'its quota over that connection. There is no documented file-based (or keychain) way to read quota ' +
    'when the app is closed, so this connector deliberately does not try — it just reports plainly when ' +
    'Antigravity is not running. Enable it only if you keep Antigravity running locally.',
  enabledByDefault: false,
  quotaEnabledByDefault: false,
  configSchema: [
    {
      key: 'portRange',
      label: 'Local port range to scan',
      type: 'string',
      section: 'quota',
      requiresEnabled: 'quota',
      default: DEFAULT_PORT_RANGE,
      help:
        `Format "<start>-<end>", e.g. "${DEFAULT_PORT_RANGE}". The default range is an educated guess, ` +
        'not verified against a real Antigravity install — override it if you know the actual port ' +
        '(check Task Manager / `netstat` while Antigravity is running). Scanning is capped and short-timeout ' +
        'per port, so a wrong range just fails fast rather than hanging.',
    },
  ],
  quota: {
    defaultIntervalMinutes: 15,
    create: createAntigravityQuotaProvider,
  },
};

export default AntigravityConnector;

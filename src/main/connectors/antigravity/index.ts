import { Connector } from '../types';
import { createAntigravityQuotaProvider, DEFAULT_PORT_RANGE } from './quota';

const AntigravityConnector: Connector = {
  id: 'antigravity',
  name: 'Antigravity',
  vendor: 'Google',
  description:
    'Off by default: unlike every other connector here, this one only works while the Antigravity app is ' +
    'open on this machine — it locates the running language-server process, reads its port and CSRF token ' +
    'from the process arguments, and queries quota over that connection. There is no documented file-based ' +
    '(or keychain) way to read quota when the app is closed, so this connector deliberately does not try — ' +
    'it just reports plainly when Antigravity is not running. Enable it only if you keep Antigravity ' +
    'running locally.',
  enabledByDefault: false,
  quotaEnabledByDefault: false,
  configSchema: [
    {
      key: 'portRange',
      label: 'Fallback port range to scan',
      type: 'string',
      section: 'quota',
      requiresEnabled: 'quota',
      default: DEFAULT_PORT_RANGE,
      help:
        'Only used if the language-server process cannot be found. Antigravity picks an ephemeral port, so ' +
        `there is no known range to scan — "${DEFAULT_PORT_RANGE}" is just a small default. Override it with ` +
        'the real port (check `netstat` while Antigravity is running) if discovery ever fails. Scanning is ' +
        'short-timeout per port, so a wrong range fails fast rather than hanging.',
    },
  ],
  quota: {
    defaultIntervalMinutes: 15,
    create: createAntigravityQuotaProvider,
  },
};

export default AntigravityConnector;

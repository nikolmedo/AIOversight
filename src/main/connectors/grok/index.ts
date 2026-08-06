import { Connector } from '../types';
import { createGrokQuotaProvider } from './quota';

const GrokConnector: Connector = {
  id: 'grok',
  name: 'Grok CLI',
  vendor: 'xAI',
  description:
    'Reads the Grok CLI\'s local ~/.grok/auth.json session to track weekly usage and pay-as-you-go status, ' +
    'auto-refreshing the token when it expires, plus local spend estimated from ~/.grok/logs/unified.jsonl.',
  enabledByDefault: false,
  configSchema: [],
  quota: {
    defaultIntervalMinutes: 15,
    create: createGrokQuotaProvider,
  },
};

export default GrokConnector;

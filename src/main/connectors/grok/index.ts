import { Connector } from '../types';
import { createGrokQuotaProvider } from './quota';

const GrokConnector: Connector = {
  id: 'grok',
  name: 'Grok CLI',
  vendor: 'xAI',
  description:
    'Reads the Grok CLI\'s local ~/.grok/auth.json session to track weekly usage and pay-as-you-go status, ' +
    'plus spend from the CLI\'s own per-session transcripts. Read-only: it never refreshes or rewrites the ' +
    'CLI\'s credentials, so an expired session sends you back to `grok login`.',
  enabledByDefault: false,
  configSchema: [],
  quota: {
    defaultIntervalMinutes: 15,
    reportsSpend: true,
    create: createGrokQuotaProvider,
  },
};

export default GrokConnector;

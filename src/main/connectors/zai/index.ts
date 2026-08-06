import { Connector } from '../types';
import { createZaiQuotaProvider } from './quota';

const ZaiConnector: Connector = {
  id: 'zai',
  name: 'Z.ai / GLM',
  vendor: 'Z.ai',
  description:
    'Tracks your Z.ai (GLM) subscription session/weekly quota windows and web-search allowance using an API key.',
  enabledByDefault: false,
  configSchema: [
    {
      key: 'apiKey',
      label: 'API key',
      type: 'secret',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help:
        'Found in your Z.ai account settings. Falls back to the ZAI_API_KEY (then legacy GLM_API_KEY) environment variable when unset. Stays encrypted on this machine.',
    },
  ],
  quota: {
    defaultIntervalMinutes: 15,
    create: createZaiQuotaProvider,
  },
};

export default ZaiConnector;

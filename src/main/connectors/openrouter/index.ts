import { Connector } from '../types';
import { createOpenRouterQuotaProvider } from './quota';

const OpenRouterConnector: Connector = {
  id: 'openrouter',
  name: 'OpenRouter',
  vendor: 'OpenRouter',
  description:
    'Tracks your OpenRouter prepaid credit balance and lifetime spend using a per-account API key.',
  enabledByDefault: false,
  configSchema: [
    {
      key: 'apiKey',
      label: 'API key (sk-or-v1-…)',
      type: 'secret',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help:
        'Create one at openrouter.ai/settings/keys. Falls back to the OPENROUTER_API_KEY environment variable when unset. Stays encrypted on this machine.',
    },
  ],
  quota: {
    defaultIntervalMinutes: 15,
    create: createOpenRouterQuotaProvider,
  },
};

export default OpenRouterConnector;

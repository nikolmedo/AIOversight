import { Connector } from '../types';
import { createAnthropicQuotaProvider } from './quota';

const AnthropicConnector: Connector = {
  id: 'anthropic',
  name: 'Anthropic Console',
  vendor: 'Anthropic',
  description:
    'Pulls organization-level usage from the Anthropic Admin API. Optionally falls back to a claude.ai browser session cookie when no admin key is set.',
  enabledByDefault: false,
  configSchema: [
    {
      key: 'adminApiKey',
      label: 'Admin API key (sk-ant-admin01-…)',
      type: 'secret',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help:
        'Create one at console.anthropic.com/settings/admin-keys. Stays encrypted on this machine.',
    },
  ],
  quota: {
    defaultIntervalMinutes: 15,
    create: createAnthropicQuotaProvider,
  },
};

export default AnthropicConnector;

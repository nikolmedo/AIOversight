import { Connector } from '../types';
import { createOpenAIQuotaProvider } from './quota';

const OpenAIConnector: Connector = {
  id: 'openai',
  name: 'OpenAI / ChatGPT',
  vendor: 'OpenAI',
  description:
    'Pulls organization-level token + cost usage from OpenAI using an admin API key. Covers ChatGPT API, Codex CLI, and other OpenAI-API-backed tools.',
  enabledByDefault: false,
  configSchema: [
    {
      key: 'adminApiKey',
      label: 'Admin API key (sk-admin-… or sk-… with api.usage.read)',
      type: 'secret',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help:
        'Create one at platform.openai.com/settings/organization/admin-keys. Stays encrypted on this machine.',
    },
  ],
  quota: {
    defaultIntervalMinutes: 15,
    create: createOpenAIQuotaProvider,
  },
};

export default OpenAIConnector;

import { Connector } from '../types';
import { createCopilotQuotaProvider } from './quota';

const CopilotConnector: Connector = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  vendor: 'GitHub',
  description:
    'Pulls Copilot usage metrics and seat counts for a GitHub organisation or enterprise. Org/enterprise admin access required — GitHub does not expose per-user Copilot quota for individual plans.',
  enabledByDefault: false,
  configSchema: [
    {
      key: 'slugType',
      label: 'Slug type',
      type: 'enum',
      section: 'quota',
      requiresEnabled: 'quota',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Auto-detect (try org, then enterprise)' },
        { value: 'org', label: 'Organization' },
        { value: 'enterprise', label: 'Enterprise' },
      ],
      help:
        'Copilot Standalone customers usually have an enterprise slug. If your slug 404s as an org but works in the enterprise UI, switch to Enterprise.',
    },
    {
      key: 'org',
      label: 'GitHub organization or enterprise slug',
      type: 'string',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help:
        'e.g. "octocat-corp" for an org, or your enterprise slug from the URL https://github.com/enterprises/<slug>.',
    },
    {
      key: 'githubPat',
      label: 'GitHub PAT',
      type: 'secret',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help:
        'Classic PAT with manage_billing:copilot + read:org (org) or read:enterprise (enterprise). Or a fine-grained token with the equivalent permissions. Stays encrypted on this machine.',
    },
  ],
  quota: {
    defaultIntervalMinutes: 60,
    create: createCopilotQuotaProvider,
  },
};

export default CopilotConnector;

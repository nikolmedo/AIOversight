import { Connector } from '../types';
import { createCodexCliDetector } from './detector';
import { createCodexCliQuotaProvider } from './quota';

const CodexCliConnector: Connector = {
  id: 'codex-cli',
  name: 'Codex CLI',
  vendor: 'OpenAI',
  description:
    'Watches ~/.codex/sessions JSONL rollouts for tool approvals and finished turns, and reads your ' +
    'ChatGPT-plan Codex usage (session / weekly limits) from the same `codex login` session. ' +
    '(For org-level API billing, use the OpenAI connector instead — that\'s a different, admin-key-based quota.)',
  enabledByDefault: true,
  quotaEnabledByDefault: true,
  configSchema: [
    {
      key: 'paths',
      label: 'Session paths',
      type: 'paths',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: [
        '~/.codex/sessions/**/*.jsonl',
        '~/AppData/Roaming/codex/sessions/**/*.jsonl',
      ],
    },
    {
      key: 'idleSeconds',
      label: 'Idle threshold (seconds)',
      type: 'number',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: 6,
    },
  ],
  detector: { create: createCodexCliDetector },
  quota: {
    defaultIntervalMinutes: 15,
    create: createCodexCliQuotaProvider,
  },
};

export default CodexCliConnector;

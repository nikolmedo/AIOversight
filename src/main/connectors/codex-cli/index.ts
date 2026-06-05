import { Connector } from '../types';
import { createCodexCliDetector } from './detector';

const CodexCliConnector: Connector = {
  id: 'codex-cli',
  name: 'Codex CLI',
  vendor: 'OpenAI',
  description:
    'Watches ~/.codex/sessions JSONL rollouts for tool approvals and finished turns. (For OpenAI usage quota, enable the OpenAI connector.)',
  enabledByDefault: true,
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
};

export default CodexCliConnector;

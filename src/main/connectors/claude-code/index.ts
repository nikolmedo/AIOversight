import { Connector } from '../types';
import { createClaudeCodeDetector } from './detector';
import { createClaudeCodeQuotaProvider } from './quota';
import { startClaudeLogin } from './browser-session';

const ClaudeCodeConnector: Connector = {
  id: 'claude-code',
  name: 'Claude Code',
  vendor: 'Anthropic',
  description:
    'Watches ~/.claude/projects transcripts for permission prompts and finished turns. ' +
    'Enable Quota to track your claude.ai plan usage (5-hour and 7-day limits) — a sign-in window opens once, then it refreshes automatically.',
  enabledByDefault: true,
  configSchema: [
    {
      key: 'paths',
      label: 'Transcript paths',
      type: 'paths',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: [
        '~/.claude/projects/**/*.jsonl',
        '~/AppData/Roaming/Claude/projects/**/*.jsonl',
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
  detector: { create: createClaudeCodeDetector },
  quota: {
    defaultIntervalMinutes: 30,
    create: createClaudeCodeQuotaProvider,
  },
  login: {
    label: 'Sign in to Claude',
    handler: (_ctx, cb) => startClaudeLogin(cb),
  },
};

export default ClaudeCodeConnector;

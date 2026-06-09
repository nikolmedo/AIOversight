import { Connector } from '../types';
import { createCursorDetector } from './detector';
import { createCursorQuotaProvider, defaultCursorStateDbPath } from './quota';

const CursorConnector: Connector = {
  id: 'cursor',
  name: 'Cursor IDE',
  vendor: 'Anysphere',
  description:
    'Watches Cursor agent transcripts for sessions waiting on approval and finished turns, and reads your usage quota from Cursor.',
  enabledByDefault: true,
  quotaEnabledByDefault: true,
  configSchema: [
    {
      key: 'paths',
      label: 'Transcript paths',
      type: 'paths',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: [
        '~/.cursor/projects/**/agent-transcripts/**/*.jsonl',
        '~/AppData/Roaming/Cursor/User/projects/**/agent-transcripts/**/*.jsonl',
      ],
      help: 'Glob patterns for Cursor transcript JSONL files. Restart the app after editing.',
    },
    {
      key: 'idleSeconds',
      label: 'Idle threshold (seconds)',
      type: 'number',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: 8,
      help:
        'How long the transcript must sit unchanged with the assistant as last speaker ' +
        'before we treat it as waiting on you (or finished).',
    },
    {
      key: 'stateDbPath',
      label: 'state.vscdb path (optional)',
      type: 'string',
      section: 'quota',
      requiresEnabled: 'quota',
      default: '',
      help:
        'Override the auto-detected Cursor state DB path. Leave blank to use ' +
        `the platform default (${defaultCursorStateDbPath()}).`,
    },
  ],
  detector: { create: createCursorDetector },
  quota: {
    defaultIntervalMinutes: 5,
    create: createCursorQuotaProvider,
  },
};

export default CursorConnector;

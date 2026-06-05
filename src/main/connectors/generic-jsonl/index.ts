import { Connector, ConnectorContext, Detector, LineStatus } from '../types';
import { TranscriptWatcher } from '../shared/transcript-watcher';

/**
 * Generic JSONL transcript watcher. Useful for any tool that writes a
 * conversation log we don't have a built-in connector for (Aider, Cline,
 * Continue, etc.). The user supplies glob paths and we apply the same
 * idle-after-assistant heuristic.
 */
function createGenericJsonlDetector(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): Detector {
  const patterns = (config.paths as string[] | undefined) ?? [];
  const idleSeconds = (config.idleSeconds as number | undefined) ?? 8;
  const label = (config.agentLabel as string | undefined) ?? 'Custom';
  return new TranscriptWatcher(
    {
      agentName: label,
      detectorId: 'generic-jsonl',
      patterns,
      idleMs: Math.max(2, idleSeconds) * 1000,
      extractStatus(line): LineStatus {
        if (!line || typeof line !== 'object') return 'unknown';
        const obj = line as Record<string, unknown>;
        const candidates = [obj.role, obj.type, obj.speaker, obj.author]
          .filter((c): c is string => typeof c === 'string')
          .map(c => c.toLowerCase());
        if (candidates.length === 0) return 'unknown';
        for (const s of candidates) {
          if (s.startsWith('user') || s === 'human') return 'user';
        }
        for (const s of candidates) {
          if (s.includes('result') || s.includes('output')) return 'tool';
          if (s.includes('tool') || s.includes('function')) return 'pending';
        }
        for (const s of candidates) {
          if (s.startsWith('assistant') || s === 'ai' || s === 'model') return 'final';
        }
        return 'unknown';
      },
      extractSnippet(line) {
        if (!line || typeof line !== 'object') return undefined;
        const obj = line as Record<string, unknown>;
        if (typeof obj.text === 'string') return obj.text;
        if (typeof obj.content === 'string') return obj.content;
        return undefined;
      },
    },
    ctx,
  );
}

const GenericJsonlConnector: Connector = {
  id: 'generic-jsonl',
  name: 'Custom JSONL transcripts',
  vendor: 'Custom',
  description:
    'Add your own glob paths for any agent that streams JSONL transcripts (Aider, Cline, etc).',
  enabledByDefault: false,
  configSchema: [
    {
      key: 'paths',
      label: 'Transcript paths',
      type: 'paths',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: [],
      help: 'One glob per line. Restart the app after editing.',
    },
    {
      key: 'agentLabel',
      label: 'Agent label',
      type: 'string',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: 'Custom',
    },
    {
      key: 'idleSeconds',
      label: 'Idle threshold (seconds)',
      type: 'number',
      section: 'notifications',
      requiresEnabled: 'notifications',
      default: 8,
    },
  ],
  detector: { create: createGenericJsonlDetector },
};

export default GenericJsonlConnector;

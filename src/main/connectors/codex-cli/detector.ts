import { ConnectorContext, Detector, LineStatus } from '../types';
import { TranscriptWatcher } from '../shared/transcript-watcher';

/**
 * OpenAI Codex CLI / `codex` agent notification detector.
 *
 * Codex stores rollouts under ~/.codex/sessions/<date>/<session>.jsonl.
 * Each line has `type` like `user_message`, `assistant_message`,
 * `function_call`, `function_call_output`.
 */
export function createCodexCliDetector(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): Detector {
  const patterns = (config.paths as string[] | undefined) ?? [];
  const idleSeconds = (config.idleSeconds as number | undefined) ?? 6;
  return new TranscriptWatcher(
    {
      agentName: 'Codex',
      detectorId: 'codex-cli',
      patterns,
      idleMs: Math.max(2, idleSeconds) * 1000,
      extractStatus(line): LineStatus {
        if (!line || typeof line !== 'object') return 'unknown';
        const obj = line as Record<string, unknown>;
        const t = String(obj.type ?? obj.role ?? '');
        if (t.startsWith('user')) return 'user';
        if (t === 'function_call_output' || t.includes('tool_result')) return 'tool';
        if (t.startsWith('function_call')) return 'pending';
        if (t.startsWith('assistant')) return 'final';
        if (t.includes('tool')) return 'tool';
        return 'unknown';
      },
      extractSnippet(line) {
        if (!line || typeof line !== 'object') return undefined;
        const obj = line as Record<string, unknown>;
        if (typeof obj.name === 'string' && String(obj.type ?? '').startsWith('function_call')) {
          return `Tool '${obj.name}' awaiting approval`;
        }
        if (typeof obj.text === 'string') return obj.text;
        if (typeof obj.content === 'string') return obj.content;
        return undefined;
      },
    },
    ctx,
  );
}

import { ConnectorContext, Detector, LineStatus } from '../types';
import { TranscriptWatcher } from '../shared/transcript-watcher';

/**
 * Cursor IDE notification detector.
 *
 * Cursor stores per-conversation JSONL transcripts under
 *   ~/.cursor/projects/<project-hash>/agent-transcripts/<session-id>/<session-id>.jsonl
 *
 * Each line is a JSON object of the form:
 *   { "role": "user" | "assistant" | "tool" | "system", "message": { ... } }
 *
 * Status mapping for the last line:
 *   - role=user                                -> 'user'   (no event)
 *   - role=tool                                -> 'tool'   (waiting; orphan
 *                                                          tool result)
 *   - role=assistant + content has tool_use    -> 'pending' (waiting)
 *   - role=assistant + text only               -> 'final'   (finished)
 */
export function createCursorDetector(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): Detector {
  const patterns = (config.paths as string[] | undefined) ?? [];
  const idleSeconds = (config.idleSeconds as number | undefined) ?? 8;
  return new TranscriptWatcher(
    {
      agentName: 'Cursor',
      detectorId: 'cursor',
      patterns,
      idleMs: Math.max(2, idleSeconds) * 1000,
      extractStatus(line): LineStatus {
        if (!line || typeof line !== 'object') return 'unknown';
        const role = (line as { role?: unknown }).role;
        if (role === 'user') return 'user';
        if (role === 'tool') return 'tool';
        if (role !== 'assistant') return 'unknown';
        const msg = (line as { message?: unknown }).message;
        if (msg && typeof msg === 'object') {
          const content = (msg as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (
                part &&
                typeof part === 'object' &&
                (part as { type?: string }).type === 'tool_use'
              ) {
                return 'pending';
              }
            }
          }
        }
        return 'final';
      },
      extractSnippet(line) {
        if (!line || typeof line !== 'object') return undefined;
        const msg = (line as { message?: unknown }).message;
        if (!msg || typeof msg !== 'object') return undefined;
        const content = (msg as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (
              part &&
              typeof part === 'object' &&
              (part as { type?: string }).type === 'text' &&
              typeof (part as { text?: string }).text === 'string'
            ) {
              return (part as { text: string }).text;
            }
          }
        }
        if (typeof content === 'string') return content;
        return undefined;
      },
    },
    ctx,
  );
}

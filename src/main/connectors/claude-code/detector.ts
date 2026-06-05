import { ConnectorContext, Detector, LineStatus } from '../types';
import { TranscriptWatcher } from '../shared/transcript-watcher';

/**
 * Claude Code (Anthropic CLI) notification detector.
 *
 * Claude Code stores conversation history in JSONL files under
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Each line is `{ "type": "user" | "assistant" | "tool_use" | "tool_result", ... }`
 * (older formats use `role` instead of `type`).
 */
export function createClaudeCodeDetector(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): Detector {
  const patterns = (config.paths as string[] | undefined) ?? [];
  const idleSeconds = (config.idleSeconds as number | undefined) ?? 6;
  return new TranscriptWatcher(
    {
      agentName: 'Claude Code',
      detectorId: 'claude-code',
      patterns,
      idleMs: Math.max(2, idleSeconds) * 1000,
      extractStatus(line): LineStatus {
        if (!line || typeof line !== 'object') return 'unknown';
        const obj = line as Record<string, unknown>;
        const t = obj.type ?? obj.role;
        if (t === 'user') return 'user';
        if (t === 'tool_use' || t === 'tool_result' || t === 'tool') return 'tool';
        if (t !== 'assistant') return 'unknown';
        const msg = obj.message;
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
        const obj = line as Record<string, unknown>;
        const msg = obj.message;
        if (msg && typeof msg === 'object') {
          const content = (msg as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part === 'object') {
                const p = part as Record<string, unknown>;
                if (p.type === 'text' && typeof p.text === 'string') return p.text;
                if (p.type === 'tool_use' && typeof p.name === 'string') {
                  return `Tool '${p.name}' awaiting approval`;
                }
              }
            }
          }
          if (typeof content === 'string') return content;
        }
        if (typeof obj.text === 'string') return obj.text;
        return undefined;
      },
    },
    ctx,
  );
}

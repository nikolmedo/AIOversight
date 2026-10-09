import { ConnectorContext, Detector, LineStatus } from '../types';
import { TranscriptWatcher } from '../shared/transcript-watcher';

/** True for `<project>/<session-id>/subagents/agent-<id>.jsonl` (either path separator). */
export function isSubagentTranscript(file: string): boolean {
  return file.split(/[\\/]/).slice(0, -1).includes('subagents');
}

/**
 * Adds the projects glob under $CLAUDE_CONFIG_DIR to the watched patterns when the
 * variable is set, skipping it when an existing pattern already resolves to it
 * (compared case-insensitively with normalized separators).
 */
export function withConfigDirPattern(patterns: string[], ctx: ConnectorContext): string[] {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!dir) return patterns;
  const extra = `${dir.replace(/[\\/]+$/, '')}/projects/**/*.jsonl`;
  const norm = (p: string): string => ctx.resolvePath(p).replace(/\\/g, '/').toLowerCase();
  if (patterns.some(p => norm(p) === norm(extra))) return patterns;
  return [...patterns, extra];
}

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
  const patterns = withConfigDirPattern((config.paths as string[] | undefined) ?? [], ctx);
  const idleSeconds = (config.idleSeconds as number | undefined) ?? 6;
  return new TranscriptWatcher(
    {
      agentName: 'Claude Code',
      detectorId: 'claude-code',
      patterns,
      idleMs: Math.max(2, idleSeconds) * 1000,
      ignorePath: isSubagentTranscript,
      extractStatus(line): LineStatus {
        if (!line || typeof line !== 'object') return 'unknown';
        const obj = line as Record<string, unknown>;
        // Subagent (sidechain) turns must not notify on their own.
        if (obj.isSidechain === true) return 'unknown';
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
          // An assistant line with neither text nor tool_use (Claude Code
          // writes one line per content block, so a turn can end on a
          // thinking-only line) is a finished turn with nothing to quote.
          // '' rather than undefined: the watcher keeps the previous snippet
          // on undefined, which would pair this "finished" event with the
          // earlier "Tool '…' awaiting approval" text. An empty snippet
          // falls back to the watcher's default "finished" message.
          if ((obj.type ?? obj.role) === 'assistant' && typeof obj.text !== 'string') return '';
        }
        if (typeof obj.text === 'string') return obj.text;
        return undefined;
      },
    },
    ctx,
  );
}

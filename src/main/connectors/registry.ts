import { Connector } from './types';
import CursorConnector from './cursor';
import ClaudeCodeConnector from './claude-code';
import CodexCliConnector from './codex-cli';
import GenericJsonlConnector from './generic-jsonl';
import WebhookConnector from './webhook';
import AnthropicConnector from './anthropic';
import OpenAIConnector from './openai';
import GitHubCopilotConnector from './github-copilot';

/**
 * Built-in connector registry. Order is the display order in the
 * Integrations tab. To add a new connector:
 *
 *   1. Create `src/main/connectors/<id>/index.ts` exporting a default
 *      `Connector` definition (and any helpers like `detector.ts` /
 *      `quota.ts` it needs).
 *   2. Append it here.
 *   3. (Optional) Add a smoke test for its parsers in `scripts/smoke.js`.
 *
 * No other file needs to change — settings, IPC, UI, and tray adapt
 * automatically.
 */
export const ALL_CONNECTORS: Connector[] = [
  CursorConnector,
  AnthropicConnector,
  ClaudeCodeConnector,
  OpenAIConnector,
  CodexCliConnector,
  GitHubCopilotConnector,
  GenericJsonlConnector,
  WebhookConnector,
];

export function findConnector(id: string): Connector | undefined {
  return ALL_CONNECTORS.find(c => c.id === id);
}

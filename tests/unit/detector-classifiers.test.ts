import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { findConnector } from '../../src/main/connectors/registry';
import { TranscriptWatcher, TranscriptWatcherOptions } from '../../src/main/connectors/shared/transcript-watcher';
import { createFakeContext } from '../helpers/fake-context';

/** Reach into the TranscriptWatcher's opts to extract the connector's classifier hooks. */
function classifierFor(connectorId: string, config: Record<string, unknown> = {}): TranscriptWatcherOptions {
  const def = findConnector(connectorId);
  assert.ok(def?.detector, `expected connector "${connectorId}" to have a detector`);
  const ctx = createFakeContext();
  const detector = def!.detector!.create(config, ctx) as TranscriptWatcher;
  return detector.opts;
}

describe('Cursor classifier (extractStatus) — edge cases', () => {
  const opts = classifierFor('cursor', { paths: [], idleSeconds: 4 });

  it('returns "unknown" for a malformed (non-object) line', () => {
    // Arrange
    const line = 'not-an-object';

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'unknown');
  });

  it('returns "unknown" for null', () => {
    // Arrange / Act
    const status = opts.extractStatus(null);

    // Assert
    assert.equal(status, 'unknown');
  });

  it('returns "unknown" for an empty object (no role)', () => {
    // Arrange
    const line = {};

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'unknown');
  });

  it('returns "unknown" for an unrecognised role value', () => {
    // Arrange
    const line = { role: 'system', message: { content: [] } };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'unknown');
  });

  it('returns "final" for an assistant message whose content is not an array', () => {
    // Arrange
    const line = { role: 'assistant', message: { content: 'plain string content' } };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'final');
  });

  it('extractSnippet returns the string content when message.content is a plain string', () => {
    // Arrange
    const line = { role: 'assistant', message: { content: 'All done.' } };

    // Act
    const snippet = opts.extractSnippet?.(line);

    // Assert
    assert.equal(snippet, 'All done.');
  });
});

describe('Claude Code classifier (extractStatus) — edge cases', () => {
  const opts = classifierFor('claude-code', { paths: [], idleSeconds: 4 });

  it('returns "unknown" for a malformed (non-object) line', () => {
    // Arrange / Act
    const status = opts.extractStatus(42);

    // Assert
    assert.equal(status, 'unknown');
  });

  it('returns "unknown" when neither type nor role is present', () => {
    // Arrange
    const line = { message: { content: [] } };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'unknown');
  });

  it('falls back to "role" when "type" is absent (older transcript format)', () => {
    // Arrange
    const line = { role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'user');
  });

  it('treats type "tool" as an orphan tool result', () => {
    // Arrange
    const line = { type: 'tool', tool_use_id: 'toolu_01' };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'tool');
  });

  it('returns "final" for an assistant message with text content and no tool_use', () => {
    // Arrange
    const line = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'All set, anything else?' }] },
    };

    // Act
    const status = opts.extractStatus(line);
    const snippet = opts.extractSnippet?.(line);

    // Assert
    assert.equal(status, 'final');
    assert.equal(snippet, 'All set, anything else?');
  });

  it('extractSnippet describes a pending tool_use by name', () => {
    // Arrange
    const line = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check that.' },
          { type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    };

    // Act
    const status = opts.extractStatus(line);
    const snippet = opts.extractSnippet?.(line);

    // Assert
    assert.equal(status, 'pending');
    // First content part with type 'text' wins.
    assert.equal(snippet, 'Let me check that.');
  });

  it('extractSnippet falls back to a top-level "text" field when there is no message', () => {
    // Arrange
    const line = { type: 'assistant', text: 'Top-level text fallback' };

    // Act
    const snippet = opts.extractSnippet?.(line);

    // Assert
    assert.equal(snippet, 'Top-level text fallback');
  });
});

describe('Codex CLI classifier (extractStatus) — edge cases', () => {
  const opts = classifierFor('codex-cli', { paths: [], idleSeconds: 4 });

  it('returns "unknown" for a malformed (non-object) line', () => {
    // Arrange / Act
    const status = opts.extractStatus(['array', 'not', 'object']);

    // Assert
    assert.equal(status, 'unknown');
  });

  it('returns "unknown" for an empty object (no type or role)', () => {
    // Arrange
    const line = {};

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'unknown');
  });

  it('treats any type prefixed with "tool" as a tool result', () => {
    // Arrange
    const line = { type: 'tool_result_event' };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'tool');
  });

  it('extractSnippet describes a pending function_call by name', () => {
    // Arrange
    const line = { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' };

    // Act
    const status = opts.extractStatus(line);
    const snippet = opts.extractSnippet?.(line);

    // Assert
    assert.equal(status, 'pending');
    assert.equal(snippet, "Tool 'shell' awaiting approval");
  });

  it('extractSnippet falls back to "content" string field', () => {
    // Arrange
    const line = { type: 'assistant_message', content: 'Refactor complete.' };

    // Act
    const snippet = opts.extractSnippet?.(line);

    // Assert
    assert.equal(snippet, 'Refactor complete.');
  });
});

describe('Generic JSONL classifier (extractStatus) — speaker/author heuristics', () => {
  const opts = classifierFor('generic-jsonl', { paths: [], idleSeconds: 4, agentLabel: 'Aider' });

  it('returns "unknown" for a malformed (non-object) line', () => {
    // Arrange / Act
    const status = opts.extractStatus('plain string');

    // Assert
    assert.equal(status, 'unknown');
  });

  it('returns "unknown" when none of role/type/speaker/author are present', () => {
    // Arrange
    const line = { text: 'hello' };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'unknown');
  });

  it('classifies "human" speaker as user', () => {
    // Arrange
    const line = { speaker: 'human', text: 'Add a test for this.' };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'user');
  });

  it('classifies "ai" author as final', () => {
    // Arrange
    const line = { author: 'ai', text: 'Added the test.' };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'final');
  });

  it('classifies "model" author as final', () => {
    // Arrange
    const line = { author: 'model', content: 'Done.' };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'final');
  });

  it('classifies a speaker containing "tool" as pending', () => {
    // Arrange
    const line = { speaker: 'tool_call', text: 'Running build...' };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'pending');
  });

  it('classifies a speaker containing "result" as a tool result', () => {
    // Arrange
    const line = { speaker: 'tool_result', content: 'exit code 0' };

    // Act
    const status = opts.extractStatus(line);

    // Assert
    assert.equal(status, 'tool');
  });

  it('extractSnippet prefers "text" over "content"', () => {
    // Arrange
    const line = { author: 'assistant', text: 'from text', content: 'from content' };

    // Act
    const snippet = opts.extractSnippet?.(line);

    // Assert
    assert.equal(snippet, 'from text');
  });
});

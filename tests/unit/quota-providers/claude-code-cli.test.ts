import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseCliOutput, stripAnsi } from '../../../src/main/connectors/claude-code/cli-quota';
import {
  claudeCliUsageOutputWithAnsi,
  claudeCliUsageOutputPlain,
  claudeCliUsageOutputUnexpected,
} from '../../helpers/fixtures';

describe('stripAnsi', () => {
  it('removes ANSI color escape codes', () => {
    // Arrange
    const raw = '\x1B[36mCurrent session\x1B[0m';

    // Act
    const result = stripAnsi(raw);

    // Assert
    assert.equal(result, 'Current session');
  });

  it('removes cursor-movement and charset escape sequences', () => {
    // Arrange
    const raw = '\x1B[2K\x1B(B42% used';

    // Act
    const result = stripAnsi(raw);

    // Assert
    assert.equal(result, '42% used');
  });

  it('returns plain text unchanged', () => {
    // Arrange
    const raw = 'Current session\n  42% used';

    // Act
    const result = stripAnsi(raw);

    // Assert
    assert.equal(result, raw);
  });
});

describe('parseCliOutput', () => {
  it('parses an ANSI-colored "claude /usage" output into session and week buckets', () => {
    // Arrange
    const raw = claudeCliUsageOutputWithAnsi();

    // Act
    const snap = parseCliOutput(raw);

    // Assert
    assert.ok(snap, 'expected a non-null snapshot');
    assert.equal(snap!.ok, true);
    if (!snap!.ok) return;
    assert.equal(snap!.authMethod, 'cli');
    assert.equal(snap!.source, 'cli');
    assert.equal(snap!.membershipType, 'Claude (claude.ai)');

    const fiveHour = snap!.buckets.find(b => b.id === 'five-hour');
    const sevenDay = snap!.buckets.find(b => b.id === 'seven-day');
    assert.ok(fiveHour);
    assert.ok(sevenDay);
    assert.equal(fiveHour!.used, 42);
    assert.equal(fiveHour!.limit, 100);
    assert.equal(fiveHour!.remaining, 58);
    assert.equal(sevenDay!.used, 18);
    assert.equal(sevenDay!.limit, 100);
    assert.equal(sevenDay!.remaining, 82);

    assert.deepEqual(snap!.displayMessages, [
      '5-hour limit resets 2h 15m',
      '7-day limit resets Mon, Jun 15',
    ]);
  });

  it('parses output without ANSI escape codes', () => {
    // Arrange
    const raw = claudeCliUsageOutputPlain();

    // Act
    const snap = parseCliOutput(raw);

    // Assert
    assert.ok(snap, 'expected a non-null snapshot');
    assert.equal(snap!.ok, true);
    if (!snap!.ok) return;
    const fiveHour = snap!.buckets.find(b => b.id === 'five-hour');
    const sevenDay = snap!.buckets.find(b => b.id === 'seven-day');
    assert.equal(fiveHour!.used, 42);
    assert.equal(sevenDay!.used, 18);
  });

  it('returns null for unexpected output (e.g. not logged in)', () => {
    // Arrange
    const raw = claudeCliUsageOutputUnexpected();

    // Act
    const snap = parseCliOutput(raw);

    // Assert
    assert.equal(snap, null);
  });

  it('returns null for empty output', () => {
    // Arrange
    const raw = '';

    // Act
    const snap = parseCliOutput(raw);

    // Assert
    assert.equal(snap, null);
  });

  it('returns null when only one of the two sections is present', () => {
    // Arrange
    const raw = ['Current session', '  42% used', '  Resets 2h 15m'].join('\n');

    // Act
    const snap = parseCliOutput(raw);

    // Assert
    assert.equal(snap, null);
  });
});

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatTrayLineFor } from '../../src/main/tray';
import { QuotaSnapshot } from '../../src/main/connectors/types';
import {
  quotaSnapshotWithBuckets,
  quotaSnapshotError,
  quotaSnapshotWithoutLimits,
} from '../helpers/fixtures';

describe('formatTrayLineFor', () => {
  it('formats an ok snapshot with limit/remaining buckets as a percentage', () => {
    // Arrange
    const snap = quotaSnapshotWithBuckets() as QuotaSnapshot;

    // Act
    const line = formatTrayLineFor('Claude Code', snap);

    // Assert
    // First bucket is five-hour: used=42, limit=100 -> 42% used
    assert.equal(line, 'Claude Code: 42% used');
  });

  it('returns null for an error snapshot', () => {
    // Arrange
    const snap = quotaSnapshotError('No admin API key set.') as QuotaSnapshot;

    // Act
    const line = formatTrayLineFor('Anthropic Console', snap);

    // Assert
    assert.equal(line, null);
  });

  it('formats a snapshot without limit/remaining as a raw used count', () => {
    // Arrange
    const snap = quotaSnapshotWithoutLimits() as QuotaSnapshot;

    // Act
    const line = formatTrayLineFor('Anthropic Console', snap);

    // Assert
    // bucket.limit and bucket.remaining are both null -> falls back to "used unit",
    // formatted via Number.prototype.toLocaleString() (locale-dependent separators).
    assert.equal(line, `Anthropic Console: ${(20_000).toLocaleString()} requests`);
  });

  it('uses snap.trayLine verbatim when present', () => {
    // Arrange
    const snap: QuotaSnapshot = {
      ok: true,
      fetchedAt: Date.now(),
      buckets: [],
      displayMessages: [],
      trayLine: 'Sign in required',
    };

    // Act
    const line = formatTrayLineFor('GitHub Copilot', snap);

    // Assert
    assert.equal(line, 'GitHub Copilot: Sign in required');
  });

  it('falls back to membershipType when there are no buckets and no trayLine', () => {
    // Arrange
    const snap: QuotaSnapshot = {
      ok: true,
      fetchedAt: Date.now(),
      buckets: [],
      displayMessages: [],
      membershipType: 'individual',
    };

    // Act
    const line = formatTrayLineFor('GitHub Copilot', snap);

    // Assert
    assert.equal(line, 'GitHub Copilot: individual');
  });

  it('falls back to "connected" when there are no buckets, no trayLine, and no membershipType', () => {
    // Arrange
    const snap: QuotaSnapshot = {
      ok: true,
      fetchedAt: Date.now(),
      buckets: [],
      displayMessages: [],
    };

    // Act
    const line = formatTrayLineFor('Custom', snap);

    // Assert
    assert.equal(line, 'Custom: connected');
  });

  it('treats a zero limit as 0% used rather than dividing by zero', () => {
    // Arrange
    const snap: QuotaSnapshot = {
      ok: true,
      fetchedAt: Date.now(),
      buckets: [
        { id: 'requests', label: 'Requests', unit: 'requests', used: 5, limit: 0, remaining: 0, enabled: true },
      ],
      displayMessages: [],
    };

    // Act
    const line = formatTrayLineFor('OpenAI', snap);

    // Assert
    assert.equal(line, 'OpenAI: 0% used');
  });
});

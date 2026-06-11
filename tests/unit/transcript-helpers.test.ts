import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { kindForStatus, truncate, shortId } from '../../src/main/connectors/shared/transcript-watcher';
import { LineStatus } from '../../src/main/connectors/types';

describe('kindForStatus', () => {
  it('maps "pending" to "waiting"', () => {
    // Arrange
    const status: LineStatus = 'pending';

    // Act
    const kind = kindForStatus(status);

    // Assert
    assert.equal(kind, 'waiting');
  });

  it('maps "tool" to "waiting"', () => {
    // Arrange
    const status: LineStatus = 'tool';

    // Act
    const kind = kindForStatus(status);

    // Assert
    assert.equal(kind, 'waiting');
  });

  it('maps "final" to "finished"', () => {
    // Arrange
    const status: LineStatus = 'final';

    // Act
    const kind = kindForStatus(status);

    // Assert
    assert.equal(kind, 'finished');
  });

  it('maps "user" to null (no event fires)', () => {
    // Arrange
    const status: LineStatus = 'user';

    // Act
    const kind = kindForStatus(status);

    // Assert
    assert.equal(kind, null);
  });

  it('maps "unknown" to null (no event fires)', () => {
    // Arrange
    const status: LineStatus = 'unknown';

    // Act
    const kind = kindForStatus(status);

    // Assert
    assert.equal(kind, null);
  });
});

describe('truncate', () => {
  it('returns the original text unchanged when under the limit', () => {
    // Arrange
    const snippet = 'Build succeeded.';

    // Act
    const result = truncate(snippet, 140);

    // Assert
    assert.equal(result, 'Build succeeded.');
  });

  it('returns the original text unchanged when exactly at the limit', () => {
    // Arrange
    const snippet = 'a'.repeat(140);

    // Act
    const result = truncate(snippet, 140);

    // Assert
    assert.equal(result, snippet);
    assert.equal(result.length, 140);
  });

  it('truncates and appends an ellipsis when over the limit', () => {
    // Arrange
    const snippet =
      'I have finished refactoring the connector registry, updated the README, ' +
      'and verified that the smoke tests still pass after the change.';

    // Act
    const result = truncate(snippet, 60);

    // Assert
    assert.equal(result.length, 60);
    assert.ok(result.endsWith('…'));
    assert.ok(snippet.startsWith(result.slice(0, -1)));
  });

  it('collapses internal whitespace before measuring length', () => {
    // Arrange
    const snippet = 'Done.\n\n  Anything   else?  ';

    // Act
    const result = truncate(snippet, 140);

    // Assert
    assert.equal(result, 'Done. Anything else?');
  });
});

describe('shortId', () => {
  it('returns short ids unchanged', () => {
    // Arrange
    const id = 'abcd1234';

    // Act
    const result = shortId(id);

    // Assert
    assert.equal(result, 'abcd1234');
  });

  it('returns ids exactly at the 10-char boundary unchanged', () => {
    // Arrange
    const id = '1234567890';

    // Act
    const result = shortId(id);

    // Assert
    assert.equal(result, '1234567890');
  });

  it('truncates ids longer than 10 chars to the first 8 chars', () => {
    // Arrange
    const id = '550e8400-e29b-41d4-a716-446655440000';

    // Act
    const result = shortId(id);

    // Assert
    assert.equal(result, '550e8400');
    assert.equal(result.length, 8);
  });
});

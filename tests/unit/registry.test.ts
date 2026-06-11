import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ALL_CONNECTORS, findConnector } from '../../src/main/connectors/registry';

describe('ALL_CONNECTORS', () => {
  it('contains every expected built-in connector with a unique stable id', () => {
    // Arrange
    const expectedIds = [
      'cursor',
      'anthropic',
      'claude-code',
      'openai',
      'codex-cli',
      'github-copilot',
      'generic-jsonl',
      'webhook',
    ];

    // Act
    const ids = ALL_CONNECTORS.map(c => c.id);

    // Assert
    for (const id of expectedIds) {
      assert.ok(ids.includes(id), `expected registry to include "${id}"`);
    }
    assert.equal(new Set(ids).size, ids.length, 'connector ids must be unique');
  });

  it('declares quota providers with a create function and a positive default interval', () => {
    // Arrange
    const withQuota = ALL_CONNECTORS.filter(c => c.quota);

    // Act / Assert
    assert.ok(withQuota.length > 0, 'expected at least one connector with quota');
    for (const c of withQuota) {
      assert.equal(typeof c.quota!.create, 'function', `${c.id}.quota.create must be a function`);
      assert.ok(
        c.quota!.defaultIntervalMinutes > 0,
        `${c.id}.quota.defaultIntervalMinutes must be > 0`,
      );
    }
  });

  it('declares detectors with a create function', () => {
    // Arrange
    const withDetector = ALL_CONNECTORS.filter(c => c.detector);

    // Act / Assert
    assert.ok(withDetector.length > 0, 'expected at least one connector with a detector');
    for (const c of withDetector) {
      assert.equal(typeof c.detector!.create, 'function', `${c.id}.detector.create must be a function`);
    }
  });

  it('every configSchema field has a valid type and a non-empty key', () => {
    // Arrange
    const validTypes = ['string', 'number', 'boolean', 'paths', 'secret', 'enum'];

    // Act / Assert
    for (const def of ALL_CONNECTORS) {
      for (const field of def.configSchema) {
        assert.ok(field.key.length > 0, `${def.id} has a configSchema field with an empty key`);
        assert.ok(
          validTypes.includes(field.type),
          `${def.id}.${field.key} has invalid type "${field.type}"`,
        );
        if (field.type === 'enum') {
          assert.ok(
            Array.isArray(field.options) && field.options.length > 0,
            `${def.id}.${field.key} is type 'enum' but has no options`,
          );
        }
      }
    }
  });

  it('cursor declares both a detector and a quota provider', () => {
    // Arrange
    const cursor = findConnector('cursor');

    // Act / Assert
    assert.ok(cursor, 'expected to find the cursor connector');
    assert.ok(cursor!.detector, 'cursor should have a detector');
    assert.ok(cursor!.quota, 'cursor should have a quota provider');
  });

  it('webhook declares a detector but no quota provider', () => {
    // Arrange
    const webhook = findConnector('webhook');

    // Act / Assert
    assert.ok(webhook, 'expected to find the webhook connector');
    assert.ok(webhook!.detector, 'webhook should have a detector');
    assert.equal(webhook!.quota, undefined, 'webhook should not have a quota provider');
  });

  it('anthropic, openai, and github-copilot are quota-only (no detector)', () => {
    // Arrange
    const ids = ['anthropic', 'openai', 'github-copilot'];

    // Act / Assert
    for (const id of ids) {
      const def = findConnector(id);
      assert.ok(def, `expected to find connector "${id}"`);
      assert.ok(def!.quota, `${id} should have a quota provider`);
      assert.equal(def!.detector, undefined, `${id} should not have a detector`);
    }
  });
});

describe('findConnector', () => {
  it('returns the matching connector by id', () => {
    // Arrange
    const id = 'claude-code';

    // Act
    const result = findConnector(id);

    // Assert
    assert.ok(result);
    assert.equal(result!.id, 'claude-code');
    assert.equal(result!.name, 'Claude Code');
  });

  it('returns undefined for an unknown id', () => {
    // Arrange
    const id = 'does-not-exist';

    // Act
    const result = findConnector(id);

    // Assert
    assert.equal(result, undefined);
  });
});

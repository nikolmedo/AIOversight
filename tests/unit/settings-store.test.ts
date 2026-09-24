import './../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { setUserDataPath, resetElectronStub } from '../helpers/electron-stub';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir';
import { SettingsStore, ConnectorDefaults, sanitizeQuietHours } from '../../src/main/settings-store';
import { currentSettingsJson, legacySettingsJson, corruptedJson } from '../helpers/fixtures';

/** Defaults shaped like ConnectorRuntime.applyConfig would compute via mergeDefaults,
 * but kept minimal for SettingsStore tests (only id-keyed maps matter here). */
function connectorDefaults(): ConnectorDefaults {
  return {
    enabled: {
      cursor: { notifications: true, quota: true },
      'claude-code': { notifications: true, quota: false },
      'codex-cli': { notifications: true, quota: false },
      webhook: { notifications: true, quota: false },
      anthropic: { notifications: false, quota: false },
      openai: { notifications: false, quota: false },
      'github-copilot': { notifications: false, quota: false },
      'generic-jsonl': { notifications: false, quota: false },
    },
    config: {
      cursor: { idleSeconds: 8, paths: ['~/.cursor/projects/**/agent-transcripts/**/*.jsonl'] },
    },
    quotaDefaultEnabled: { cursor: true },
  };
}

describe('SettingsStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('aioversight-settings-store-');
    setUserDataPath(dir);
    resetElectronStub();
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it('a fresh start (no settings.json) creates defaults', () => {
    // Arrange
    const defaults = connectorDefaults();

    // Act
    const store = new SettingsStore(defaults);
    const settings = store.get();

    // Assert
    assert.equal(settings.showNotifications, true);
    assert.equal(settings.notifyOnWaiting, true);
    assert.equal(settings.notifyOnFinished, true);
    assert.equal(settings.perSessionCooldownMs, 30_000);
    assert.equal(settings.quietHours, null);
    assert.equal(settings.quotaPollMinutes, 5);
    assert.equal(settings.showQuotaInTray, true);
    assert.deepEqual(settings.connectors.enabled, defaults.enabled);
    assert.deepEqual(settings.connectors.config, defaults.config);
    assert.deepEqual(settings.recentEvents, []);
  });

  it('loads an existing realistic settings.json', () => {
    // Arrange
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(currentSettingsJson(), null, 2));

    // Act
    const store = new SettingsStore(connectorDefaults());
    const settings = store.get();

    // Assert
    assert.equal(settings.showNotifications, true);
    assert.equal(settings.notifyOnFinished, false);
    assert.equal(settings.perSessionCooldownMs, 45_000);
    assert.deepEqual(settings.quietHours, { startMinute: 1350, endMinute: 435 });
    assert.equal(settings.quotaPollMinutes, 10);
    assert.deepEqual(settings.connectors.enabled.cursor, { notifications: true, quota: true });
    assert.deepEqual(settings.connectors.enabled['claude-code'], { notifications: true, quota: false });
    assert.equal(settings.connectors.pollOverrideMinutes?.cursor, 2);
    assert.equal(settings.recentEvents.length, 1);
    assert.equal(settings.recentEvents[0].agent, 'Cursor');
    assert.equal(settings.recentEvents[0].kind, 'finished');
  });

  it('migrates legacy settings via mergeConnectors (old detectors block -> connectors)', () => {
    // Arrange
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(legacySettingsJson(), null, 2));

    // Act
    const store = new SettingsStore(connectorDefaults());
    const settings = store.get();

    // Assert
    // cursor was enabled in legacy `detectors.enabled` and quotaDefaultEnabled[cursor]=true
    // -> notifications:true, quota:true (carried over from the legacy "on" flag).
    assert.deepEqual(settings.connectors.enabled.cursor, { notifications: true, quota: true });
    // claude-code was disabled in legacy detectors.enabled.
    assert.equal(settings.connectors.enabled['claude-code'].notifications, false);
    // Legacy per-connector config is migrated.
    assert.equal(settings.connectors.config.cursor.idleSeconds, 5);
    assert.deepEqual(settings.connectors.config.cursor.paths, [
      '~/.cursor/projects/**/agent-transcripts/**/*.jsonl',
    ]);
    // Legacy top-level quota poll / tray fields are migrated.
    assert.equal(settings.quotaPollMinutes, 3);
    assert.equal(settings.showQuotaInTray, true);
    assert.equal(settings.perSessionCooldownMs, 20_000);
  });

  it('persists changes and reloads them on a fresh instance (round-trip)', () => {
    // Arrange
    const store = new SettingsStore(connectorDefaults());

    // Act
    store.update({ showNotifications: false, perSessionCooldownMs: 60_000 });
    store.setConnectorEnabled('anthropic', { quota: true });
    store.setConnectorConfig('cursor', { idleSeconds: 12 });
    store.setConnectorPollOverride('cursor', 3);

    const reloaded = new SettingsStore(connectorDefaults());
    const settings = reloaded.get();

    // Assert
    assert.equal(settings.showNotifications, false);
    assert.equal(settings.perSessionCooldownMs, 60_000);
    assert.deepEqual(settings.connectors.enabled.anthropic, { notifications: false, quota: true });
    assert.equal(settings.connectors.config.cursor.idleSeconds, 12);
    assert.equal(settings.connectors.pollOverrideMinutes?.cursor, 3);
  });

  it('setConnectorPollOverride(id, null) removes the override', () => {
    // Arrange
    const store = new SettingsStore(connectorDefaults());
    store.setConnectorPollOverride('cursor', 5);

    // Act
    store.setConnectorPollOverride('cursor', null);

    // Assert
    assert.equal(store.get().connectors.pollOverrideMinutes?.cursor, undefined);
  });

  it('handles corrupted/truncated JSON by recovering with defaults (no crash)', () => {
    // Arrange
    fs.writeFileSync(path.join(dir, 'settings.json'), corruptedJson());
    const defaults = connectorDefaults();

    // Act
    const store = new SettingsStore(defaults);
    const settings = store.get();

    // Assert
    assert.equal(settings.showNotifications, true);
    assert.deepEqual(settings.connectors.enabled, defaults.enabled);
    assert.deepEqual(settings.recentEvents, []);
  });

  it('update() merges a partial patch into existing settings', () => {
    // Arrange
    const store = new SettingsStore(connectorDefaults());

    // Act
    const result = store.update({ notifyOnWaiting: false });

    // Assert
    assert.equal(result.notifyOnWaiting, false);
    // Untouched fields remain at their defaults.
    assert.equal(result.notifyOnFinished, true);
    assert.equal(result.showNotifications, true);
  });

  it('migrates legacy whole-hour quiet hours to minutes on load', () => {
    // Arrange
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ ...currentSettingsJson(), quietHours: { startHour: 22, endHour: 7 } }),
    );

    // Act
    const settings = new SettingsStore(connectorDefaults()).get();

    // Assert
    assert.deepEqual(settings.quietHours, { startMinute: 1320, endMinute: 420 });
  });

  it('drops a malformed persisted quiet-hours value instead of loading it', () => {
    // Arrange
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ ...currentSettingsJson(), quietHours: { startMinute: 'late', endMinute: 60 } }),
    );

    // Act
    const settings = new SettingsStore(connectorDefaults()).get();

    // Assert
    assert.equal(settings.quietHours, null);
  });

  it('update() sanitizes a quiet-hours patch before storing it', () => {
    // Arrange
    const store = new SettingsStore(connectorDefaults());

    // Act
    const clamped = store.update({ quietHours: { startMinute: -5, endMinute: 5000 } });
    const legacy = store.update({ quietHours: { startHour: 23, endHour: 6 } } as never);
    const cleared = store.update({ quietHours: null });

    // Assert
    assert.deepEqual(clamped.quietHours, { startMinute: 0, endMinute: 1439 });
    assert.deepEqual(legacy.quietHours, { startMinute: 1380, endMinute: 360 });
    assert.equal(cleared.quietHours, null);
  });

  it('pushEvent prepends to recentEvents and caps at 50 entries', () => {
    // Arrange
    const store = new SettingsStore(connectorDefaults());

    // Act
    for (let i = 0; i < 55; i++) {
      store.pushEvent({
        ts: Date.now() + i,
        agent: 'Cursor',
        sessionId: `cursor:session-${i}`,
        message: `Event ${i}`,
        kind: 'finished',
      });
    }

    // Assert
    const events = store.get().recentEvents;
    assert.equal(events.length, 50);
    // Most recent push is unshifted to the front.
    assert.equal(events[0].sessionId, 'cursor:session-54');
  });

  it('clearEvents empties recentEvents and persists the change', () => {
    // Arrange
    const store = new SettingsStore(connectorDefaults());
    store.pushEvent({
      ts: Date.now(),
      agent: 'Claude Code',
      sessionId: 'claude-code:session-1',
      message: 'Session finished.',
      kind: 'finished',
    });
    assert.equal(store.get().recentEvents.length, 1);

    // Act
    store.clearEvents();

    // Assert
    assert.deepEqual(store.get().recentEvents, []);
    const reloaded = new SettingsStore(connectorDefaults());
    assert.deepEqual(reloaded.get().recentEvents, []);
  });

  it('filePath() returns the settings.json path under the userData directory', () => {
    // Arrange
    const store = new SettingsStore(connectorDefaults());

    // Act
    const filePath = store.filePath();

    // Assert
    assert.equal(filePath, path.join(dir, 'settings.json'));
  });
});

describe('sanitizeQuietHours', () => {
  it('keeps a valid minutes window and rounds fractional minutes', () => {
    assert.deepEqual(sanitizeQuietHours({ startMinute: 1350, endMinute: 435.4 }), { startMinute: 1350, endMinute: 435 });
  });

  it('converts the legacy hour shape and clamps hours to 0..23', () => {
    assert.deepEqual(sanitizeQuietHours({ startHour: 30, endHour: -1 }), { startMinute: 1380, endMinute: 0 });
  });

  it('returns null for null, non-objects and missing or non-numeric fields', () => {
    assert.equal(sanitizeQuietHours(null), null);
    assert.equal(sanitizeQuietHours('22:00'), null);
    assert.equal(sanitizeQuietHours({ startMinute: 60 }), null);
    assert.equal(sanitizeQuietHours({ startHour: NaN, endHour: 7 }), null);
  });
});

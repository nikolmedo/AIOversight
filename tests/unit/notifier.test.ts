import './../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  setUserDataPath,
  setNotificationSupported,
  resetElectronStub,
  notifications,
} from '../helpers/electron-stub';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir';
import { SettingsStore, ConnectorDefaults } from '../../src/main/settings-store';
import { Notifier } from '../../src/main/notifier';
import { AgentEvent } from '../../src/main/connectors/types';

function connectorDefaults(): ConnectorDefaults {
  return {
    enabled: { cursor: { notifications: true, quota: true } },
    config: {},
    quotaDefaultEnabled: { cursor: true },
  };
}

function baseEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    sessionId: 'cursor:abcd1234',
    agent: 'Cursor',
    detectorId: 'cursor',
    kind: 'waiting',
    message: 'Session abcd1234 is waiting on tool approval.',
    detectedAt: Date.now(),
    ...overrides,
  };
}

/** Builds a local-time timestamp for a given hour, independent of host TZ quirks. */
function atHour(hour: number, minute = 0): number {
  return new Date(2026, 5, 10, hour, minute, 0).getTime();
}

describe('Notifier.handle()', () => {
  let dir: string;
  let store: SettingsStore;
  let notifier: Notifier;

  beforeEach(() => {
    dir = makeTempDir('aioversight-notifier-');
    setUserDataPath(dir);
    resetElectronStub();
    store = new SettingsStore(connectorDefaults());
    notifier = new Notifier(store, '/path/to/icon.png');
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it('fires a Notification with the default title/body for an enabled kind', () => {
    // Arrange
    const event = baseEvent({ kind: 'waiting', agent: 'Cursor', message: 'Approve the tool call?' });

    // Act
    const result = notifier.handle(event);

    // Assert
    assert.deepEqual(result, { shown: true });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].options.title, 'Cursor is waiting for you');
    assert.equal(notifications[0].options.body, 'Approve the tool call?');
    assert.equal(notifications[0].options.silent, false);
    assert.equal(notifications[0].shown, true);
  });

  it('uses the "finished" default title and marks the notification silent', () => {
    // Arrange
    const event = baseEvent({ kind: 'finished', agent: 'Claude Code', message: 'Build complete.' });

    // Act
    const result = notifier.handle(event);

    // Assert
    assert.deepEqual(result, { shown: true });
    assert.equal(notifications[0].options.title, 'Claude Code finished');
    assert.equal(notifications[0].options.silent, true);
  });

  it('honors an explicit event.title override', () => {
    // Arrange
    const event = baseEvent({ title: 'Custom title' });

    // Act
    notifier.handle(event);

    // Assert
    assert.equal(notifications[0].options.title, 'Custom title');
  });

  it('suppresses a repeat event for the same (sessionId, kind) within the cooldown window', () => {
    // Arrange
    const first = baseEvent({ detectedAt: 1_000_000 });
    const second = baseEvent({ detectedAt: 1_000_000 + 5_000 }); // 5s later, cooldown is 30s

    // Act
    const firstResult = notifier.handle(first);
    const secondResult = notifier.handle(second);

    // Assert
    assert.deepEqual(firstResult, { shown: true });
    assert.deepEqual(secondResult, { shown: false, reason: 'cooldown' });
    assert.equal(notifications.length, 1);
  });

  it('fires again after the cooldown window has elapsed', () => {
    // Arrange
    const cooldownMs = store.get().perSessionCooldownMs;
    const first = baseEvent({ detectedAt: 1_000_000 });
    const second = baseEvent({ detectedAt: 1_000_000 + cooldownMs + 1 });

    // Act
    const firstResult = notifier.handle(first);
    const secondResult = notifier.handle(second);

    // Assert
    assert.deepEqual(firstResult, { shown: true });
    assert.deepEqual(secondResult, { shown: true });
    assert.equal(notifications.length, 2);
  });

  it('does not let a "finished" cooldown suppress a "waiting" event for the same session', () => {
    // Arrange
    const waiting = baseEvent({ kind: 'waiting', detectedAt: 1_000_000 });
    const finished = baseEvent({ kind: 'finished', detectedAt: 1_000_000 + 1_000 });

    // Act
    const waitingResult = notifier.handle(waiting);
    const finishedResult = notifier.handle(finished);

    // Assert
    // Cooldown is keyed on (sessionId, kind), so 'finished' is independent of 'waiting'.
    assert.deepEqual(waitingResult, { shown: true });
    assert.deepEqual(finishedResult, { shown: true });
    assert.equal(notifications.length, 2);
  });

  it('suppresses notifications during a same-day quiet-hours window', () => {
    // Arrange
    store.update({ quietHours: { startHour: 13, endHour: 18 } });
    const event = baseEvent({ detectedAt: atHour(15, 0) });

    // Act
    const result = notifier.handle(event);

    // Assert
    assert.deepEqual(result, { shown: false, reason: 'quiet-hours' });
    assert.equal(notifications.length, 0);
  });

  it('suppresses notifications inside an overnight quiet-hours window crossing midnight (22 -> 7)', () => {
    // Arrange
    store.update({ quietHours: { startHour: 22, endHour: 7 } });

    // Act
    const lateNight = notifier.handle(baseEvent({ sessionId: 'cursor:s1', detectedAt: atHour(23, 30) }));
    const earlyMorning = notifier.handle(baseEvent({ sessionId: 'cursor:s2', detectedAt: atHour(6, 0) }));
    const noon = notifier.handle(baseEvent({ sessionId: 'cursor:s3', detectedAt: atHour(12, 0) }));

    // Assert
    assert.deepEqual(lateNight, { shown: false, reason: 'quiet-hours' });
    assert.deepEqual(earlyMorning, { shown: false, reason: 'quiet-hours' });
    assert.deepEqual(noon, { shown: true });
    assert.equal(notifications.length, 1);
  });

  it('does not fire when the event kind is disabled (notifyOnWaiting=false)', () => {
    // Arrange
    store.update({ notifyOnWaiting: false });
    const event = baseEvent({ kind: 'waiting' });

    // Act
    const result = notifier.handle(event);

    // Assert
    assert.deepEqual(result, { shown: false, reason: 'disabled-kind' });
    assert.equal(notifications.length, 0);
  });

  it('does not fire when the event kind is disabled (notifyOnFinished=false)', () => {
    // Arrange
    store.update({ notifyOnFinished: false });
    const event = baseEvent({ kind: 'finished' });

    // Act
    const result = notifier.handle(event);

    // Assert
    assert.deepEqual(result, { shown: false, reason: 'disabled-kind' });
    assert.equal(notifications.length, 0);
  });

  it('does not fire when notifications are globally disabled', () => {
    // Arrange
    store.update({ showNotifications: false });
    const event = baseEvent();

    // Act
    const result = notifier.handle(event);

    // Assert
    assert.deepEqual(result, { shown: false, reason: 'disabled' });
    assert.equal(notifications.length, 0);
  });

  it('handles Notification.isSupported() === false without crashing and without dispatch', () => {
    // Arrange
    setNotificationSupported(false);
    const event = baseEvent();

    // Act
    const result = notifier.handle(event);

    // Assert
    assert.deepEqual(result, { shown: false, reason: 'unsupported' });
    assert.equal(notifications.length, 0);
  });

  it('still records the event to the settings store even when suppressed', () => {
    // Arrange
    store.update({ showNotifications: false });
    const event = baseEvent({ message: 'Recorded even though suppressed.' });

    // Act
    notifier.handle(event);

    // Assert
    const recent = store.get().recentEvents;
    assert.equal(recent.length, 1);
    assert.equal(recent[0].message, 'Recorded even though suppressed.');
    assert.equal(recent[0].kind, 'waiting');
  });
});

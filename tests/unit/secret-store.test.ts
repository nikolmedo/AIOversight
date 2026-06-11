import './../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { setUserDataPath, setEncryptionAvailable, resetElectronStub } from '../helpers/electron-stub';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir';
import { SecretStore } from '../../src/main/connectors/secret-store';

describe('SecretStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('aioversight-secret-store-');
    setUserDataPath(dir);
    resetElectronStub();
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it('qualify() builds a "<connectorId>::<key>" namespaced key', () => {
    // Arrange
    const connectorId = 'github-copilot';
    const key = 'copilotOauthToken';

    // Act
    const qualified = SecretStore.qualify(connectorId, key);

    // Assert
    assert.equal(qualified, 'github-copilot::copilotOauthToken');
  });

  it('set/get round-trips a value when encryption is available', () => {
    // Arrange
    setEncryptionAvailable(true);
    const store = new SecretStore();
    const qualified = SecretStore.qualify('anthropic', 'adminApiKey');

    // Act
    store.set(qualified, 'sk-ant-admin01-realistic-admin-key-value');
    const result = store.get(qualified);

    // Assert
    assert.equal(result, 'sk-ant-admin01-realistic-admin-key-value');
    assert.equal(store.has(qualified), true);
  });

  it('persists encrypted entries to disk and reloads them on a fresh instance', () => {
    // Arrange
    setEncryptionAvailable(true);
    const store = new SecretStore();
    const qualified = SecretStore.qualify('openai', 'adminApiKey');
    store.set(qualified, 'sk-admin-realistic-openai-key');

    // Act
    const reloaded = new SecretStore();

    // Assert
    assert.equal(reloaded.get(qualified), 'sk-admin-realistic-openai-key');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')) as {
      encrypted: boolean;
      entries: Record<string, string>;
    };
    assert.equal(onDisk.encrypted, true);
    // The on-disk value must not be the plaintext secret.
    assert.notEqual(onDisk.entries[qualified], 'sk-admin-realistic-openai-key');
  });

  it('falls back to plaintext storage and writes a one-time consent flag file when encryption is unavailable', () => {
    // Arrange
    setEncryptionAvailable(false);
    const store = new SecretStore();
    const qualified = SecretStore.qualify('anthropic', 'adminApiKey');

    // Act
    store.set(qualified, 'sk-ant-admin01-plaintext-fallback');

    // Assert
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')) as {
      encrypted: boolean;
      entries: Record<string, string>;
    };
    assert.equal(onDisk.encrypted, false);
    assert.equal(onDisk.entries[qualified], 'sk-ant-admin01-plaintext-fallback');

    const flagFile = path.join(dir, 'secrets.plaintext.allowed');
    assert.equal(fs.existsSync(flagFile), true);
  });

  it('delete() removes a stored key', () => {
    // Arrange
    setEncryptionAvailable(true);
    const store = new SecretStore();
    const qualified = SecretStore.qualify('github-copilot', 'copilotOauthToken');
    store.set(qualified, 'ghu_realistictoken1234567890');

    // Act
    store.delete(qualified);

    // Assert
    assert.equal(store.has(qualified), false);
    assert.equal(store.get(qualified), null);
  });

  it('qualifiedKeys() lists all stored keys', () => {
    // Arrange
    setEncryptionAvailable(true);
    const store = new SecretStore();
    store.set(SecretStore.qualify('anthropic', 'adminApiKey'), 'sk-ant-admin01-aaa');
    store.set(SecretStore.qualify('openai', 'adminApiKey'), 'sk-admin-bbb');

    // Act
    const keys = store.qualifiedKeys();

    // Assert
    assert.deepEqual(new Set(keys), new Set(['anthropic::adminApiKey', 'openai::adminApiKey']));
  });

  it('setting an empty value removes the key (does not persist empty secrets)', () => {
    // Arrange
    setEncryptionAvailable(true);
    const store = new SecretStore();
    const qualified = SecretStore.qualify('anthropic', 'adminApiKey');
    store.set(qualified, 'sk-ant-admin01-aaa');

    // Act
    store.set(qualified, '');

    // Assert
    assert.equal(store.has(qualified), false);
  });

  it('handles a corrupted secrets.json by starting with an empty store (no crash)', () => {
    // Arrange
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'secrets.json'), '{ not valid json');

    // Act
    const store = new SecretStore();

    // Assert
    assert.deepEqual(store.qualifiedKeys(), []);
  });
});

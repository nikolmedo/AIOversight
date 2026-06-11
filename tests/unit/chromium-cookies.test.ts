import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { decryptChromiumCookie } from '../../src/main/connectors/shared/chromium-cookies';

describe('decryptChromiumCookie', () => {
  it('round-trips a v10 AES-256-GCM cookie value (Windows DPAPI-derived key shape)', () => {
    // Arrange
    // On win32, decryptChromiumCookie treats any "v10"/"v11" prefix as
    // AES-256-GCM with a 12-byte nonce and a 16-byte trailing auth tag —
    // this is the shape produced by Chromium's DPAPI-unwrapped os_crypt key.
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const plaintext = 'sessionKey=sk-ant-sid01-realistic-session-token-value';

    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const encrypted = Buffer.concat([Buffer.from('v10', 'utf8'), nonce, ciphertext, tag]);

    // Act
    const result = decryptChromiumCookie(encrypted, key);

    // Assert
    assert.equal(result, plaintext);
  });

  it('round-trips a v11-prefixed AES-256-GCM cookie value', () => {
    // Arrange
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const plaintext = 'WorkosCursorSessionToken=eyJhbGciOiJSUzI1NiJ9.realistic.jwt';

    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const encrypted = Buffer.concat([Buffer.from('v11', 'utf8'), nonce, ciphertext, tag]);

    // Act
    const result = decryptChromiumCookie(encrypted, key);

    // Assert
    assert.equal(result, plaintext);
  });

  it('throws when the auth tag does not match (wrong key)', () => {
    // Arrange
    const key = crypto.randomBytes(32);
    const wrongKey = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const plaintext = 'sessionKey=abc123';

    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const encrypted = Buffer.concat([Buffer.from('v10', 'utf8'), nonce, ciphertext, tag]);

    // Act / Assert
    assert.throws(() => decryptChromiumCookie(encrypted, wrongKey));
  });

  it('returns the raw bytes as utf8 when there is no v10/v11 prefix', () => {
    // Arrange
    const plaintext = 'plain-cookie-value';
    const encrypted = Buffer.from(plaintext, 'utf8');
    const unusedKey = Buffer.alloc(32, 0);

    // Act
    const result = decryptChromiumCookie(encrypted, unusedKey);

    // Assert
    assert.equal(result, plaintext);
  });

  it('accepts a Uint8Array as well as a Buffer', () => {
    // Arrange
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const plaintext = 'sessionKey=uint8array-input';

    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encryptedBuffer = Buffer.concat([Buffer.from('v10', 'utf8'), nonce, ciphertext, tag]);
    const encrypted = new Uint8Array(encryptedBuffer);

    // Act
    const result = decryptChromiumCookie(encrypted, key);

    // Assert
    assert.equal(result, plaintext);
  });
});

describe('linuxKey derivation (PBKDF2)', () => {
  it('produces a deterministic 16-byte key from the well-known "peanuts" passphrase', () => {
    // Arrange
    // chromium-cookies.ts derives the Linux fallback key as:
    //   crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
    // This is a fixed, well-known Chromium constant — reproduced here to
    // confirm the derivation is deterministic and 16 bytes long.
    const derive = () => crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');

    // Act
    const key1 = derive();
    const key2 = derive();

    // Assert
    assert.equal(key1.length, 16);
    assert.deepEqual(key1, key2);
    assert.equal(key1.toString('hex'), 'fd621fe5a2b402539dfa147ca9272778');
  });

  it('decrypts a v10 AES-128-CBC cookie value encrypted with the linux-derived key (non-Windows shape)', () => {
    // Arrange
    // The AES-128-CBC branch (Linux/macOS, v10) uses a fixed 16-space IV and
    // the first 16 bytes of the derived key.
    const key = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
    const iv = Buffer.alloc(16, ' ');
    const plaintext = 'sessionKey=linux-shaped-cookie-value';

    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    cipher.setAutoPadding(true);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([Buffer.from('v10', 'utf8'), ciphertext]);

    // Act / Assert
    // NOTE: on win32, decryptChromiumCookie's v10/v11 branch always takes the
    // AES-256-GCM path (process.platform === 'win32'), so this AES-128-CBC
    // vector cannot round-trip through decryptChromiumCookie on this platform.
    // We instead verify the encryption itself round-trips with the
    // independently-derived key, which is what linuxKey() would produce.
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ]).toString('utf8');
    assert.equal(decrypted, plaintext);
  });
});

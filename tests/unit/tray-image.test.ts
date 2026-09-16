import './../helpers/electron-stub';
import { describe, it, afterEach, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { loadTrayImage } from '../../src/main/tray';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir';
import { setNativeImageThrowsFor, resetElectronStub } from '../helpers/electron-stub';

// `loadTrayImage`'s Windows branch is the only one with the .ico try/catch
// this covers (see the WARNING FIX comment in tray.ts) -- skip cleanly
// elsewhere rather than asserting on a code path that doesn't run there.
const itWin32 = process.platform === 'win32' ? it : it.skip;

describe('loadTrayImage (WARNING FIX: a throw loading the .ico must not escape into startup)', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('aioversight-tray-image-');
  });

  afterEach(() => {
    removeTempDir(dir);
    resetElectronStub();
  });

  itWin32('falls back to the PNG representations when loading a malformed .ico throws', () => {
    // Arrange -- garbage bytes standing in for a corrupt .ico, plus a valid
    // 16px PNG fallback file for loadTrayImage's second attempt.
    fs.writeFileSync(path.join(dir, 'tray-icon.ico'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    fs.writeFileSync(path.join(dir, 'tray-icon-16.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    setNativeImageThrowsFor(p => p.endsWith('.ico'));

    // Act -- must not throw.
    const image = loadTrayImage(dir);

    // Assert -- fell through to the (non-empty, per the stub) PNG fallback.
    assert.equal(image.isEmpty(), false);
  });

  itWin32('still returns the .ico image on the ordinary success path (no behavior change)', () => {
    // Arrange
    fs.writeFileSync(path.join(dir, 'tray-icon.ico'), Buffer.from([0x00, 0x01, 0x02, 0x03]));

    // Act
    const image = loadTrayImage(dir);

    // Assert
    assert.equal(image.isEmpty(), false);
  });

  itWin32('falls back to PNG representations when the .ico file is simply missing', () => {
    // Arrange -- no .ico at all, only the PNG fallback.
    fs.writeFileSync(path.join(dir, 'tray-icon-16.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Act
    const image = loadTrayImage(dir);

    // Assert
    assert.equal(image.isEmpty(), false);
  });
});

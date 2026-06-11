import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Creates a fresh temporary directory under the OS tmpdir, prefixed for easy
 * identification. Returns the absolute path. Caller is responsible for
 * calling `removeTempDir` (typically in `afterEach` / `finally`).
 */
export function makeTempDir(prefix = 'aioversight-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Recursively removes a directory created by `makeTempDir`. Safe to call on a missing path. */
export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

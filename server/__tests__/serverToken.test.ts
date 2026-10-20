import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateToken } from '../src/serverToken.js';

/** The standalone server's token file: what keeps the printed URL valid across restarts. */
describe('loadOrCreateToken', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-token-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('on a fresh install creates an owner-only settings dir and token file it reads back', () => {
    // The settings dir does not exist before the first persist, which runs after start.
    const dir = path.join(tmp, '.pixelmates');
    const token = loadOrCreateToken(dir);

    expect(loadOrCreateToken(dir)).toBe(token);
    const file = path.join(dir, 'server-token');
    expect(fs.readFileSync(file, 'utf-8')).toBe(token);
    // The token is a bearer secret: nobody else on the machine may read it, or list the
    // dir that holds it.
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('reuses a saved token, trimmed, and replaces one that is not a valid token', () => {
    const file = path.join(tmp, 'server-token');
    fs.writeFileSync(file, 'saved-token-0123456789\n');
    expect(loadOrCreateToken(tmp)).toBe('saved-token-0123456789');

    fs.writeFileSync(file, 'short');
    const replaced = loadOrCreateToken(tmp);
    expect(replaced).not.toBe('short');
    expect(fs.readFileSync(file, 'utf-8')).toBe(replaced);
    expect(loadOrCreateToken(tmp)).toBe(replaced);
  });
});

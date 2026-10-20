import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Per-test failure injection; the real fs does the rest. */
const inject: { link: ((to: string) => void) | null; write: ((file: string) => void) | null } = {
  link: null,
  write: null,
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      inject.link?.(String(args[1]));
      return actual.linkSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      inject.write?.(String(args[0]));
      return actual.writeFileSync(...args);
    },
  };
});

const { migrateDataDir } = await import('../src/migrateDataDir.js');

let home: string;
const legacy = (...p: string[]): string => path.join(home, '.pixel-agents', ...p);
const target = (...p: string[]): string => path.join(home, '.pixelmates', ...p);

/** Every file under a dir with its content hash, so "untouched" is a value to compare. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else
        out[path.relative(dir, full)] = createHash('sha256')
          .update(fs.readFileSync(full))
          .digest('hex');
    }
  };
  walk(dir);
  return out;
}

function seedLegacy(): void {
  fs.mkdirSync(legacy('hooks'), { recursive: true });
  fs.mkdirSync(legacy('servers'), { recursive: true });
  fs.writeFileSync(
    legacy('config.json'),
    JSON.stringify({ hooksConsent: { claude: 'granted' }, standalone: { soundEnabled: false } }),
  );
  fs.writeFileSync(legacy('layout.json'), '{"cols":9}');
  fs.writeFileSync(legacy('roster.json'), '{"members":[]}');
  fs.writeFileSync(legacy('standalone-state.json'), '{"agents":[]}');
  fs.writeFileSync(legacy('vscode-state.json'), '{"agents":[]}');
  fs.writeFileSync(legacy('server-token'), 'upstream-secret-token');
  fs.writeFileSync(legacy('server.json'), '{"port":1}');
  fs.writeFileSync(legacy('server-port'), '3100');
  fs.writeFileSync(legacy('ledger-cache.json'), '{}');
  fs.writeFileSync(legacy('hooks', 'claude-hook.js'), '// theirs');
  fs.writeFileSync(legacy('servers', '1-2.json'), '{}');
  fs.writeFileSync(legacy('config.json.backup'), 'x');
}

describe('migrateDataDir', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-migrate-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    inject.link = null;
    inject.write = null;
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('copies only the allowlist, leaves the source byte-identical, and never copies the token', () => {
    seedLegacy();
    const before = snapshot(legacy());

    expect(migrateDataDir(home)).toBe(5);

    expect(fs.readdirSync(target()).sort()).toEqual([
      'config.json',
      'layout.json',
      'roster.json',
      'standalone-state.json',
      'vscode-state.json',
    ]);
    expect(fs.existsSync(target('server-token'))).toBe(false);
    expect(snapshot(legacy())).toEqual(before);
    expect(console.log).toHaveBeenCalledWith('Copied your office from ~/.pixel-agents (5 files).');
    if (process.platform !== 'win32') {
      expect(fs.statSync(target()).mode & 0o777).toBe(0o700);
      expect(fs.statSync(target('layout.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('does not carry consent over: pixelmates asks for its own', () => {
    seedLegacy();
    migrateDataDir(home);
    const config = JSON.parse(fs.readFileSync(target('config.json'), 'utf-8'));
    expect(config).toEqual({ standalone: { soundEnabled: false } });
  });

  it('never overwrites a file already at the target', () => {
    seedLegacy();
    fs.mkdirSync(target(), { recursive: true });
    fs.writeFileSync(target('layout.json'), 'mine');

    migrateDataDir(home);

    expect(fs.readFileSync(target('layout.json'), 'utf-8')).toBe('mine');
    expect(fs.existsSync(target('roster.json'))).toBe(true);
  });

  it('still runs when an unrelated file already sits in ~/.pixelmates', () => {
    seedLegacy();
    fs.mkdirSync(target(), { recursive: true });
    fs.writeFileSync(target('ledger-cache.json'), '{}');

    expect(migrateDataDir(home)).toBe(5);
  });

  it('does nothing once ~/.pixelmates has a config, or when upstream has none', () => {
    seedLegacy();
    fs.mkdirSync(target(), { recursive: true });
    fs.writeFileSync(target('config.json'), '{}');
    expect(migrateDataDir(home)).toBe(0);
    expect(fs.existsSync(target('layout.json'))).toBe(false);

    fs.rmSync(legacy('config.json'));
    fs.rmSync(target('config.json'));
    expect(migrateDataDir(home)).toBe(0);
  });

  it('runs again after a crash before config.json, and then finishes the job', () => {
    seedLegacy();
    inject.link = (to) => {
      if (to.endsWith('roster.json')) throw new Error('simulated crash');
    };
    expect(() => migrateDataDir(home)).toThrow('simulated crash');
    expect(fs.existsSync(target('config.json'))).toBe(false);

    inject.link = null;
    migrateDataDir(home);

    expect(fs.existsSync(target('roster.json'))).toBe(true);
    expect(fs.existsSync(target('config.json'))).toBe(true);
  });

  it('skips a file that cannot be copied, naming it but not its content', () => {
    seedLegacy();
    fs.rmSync(legacy('layout.json'));
    fs.mkdirSync(legacy('layout.json')); // not a regular file: skipped silently
    fs.writeFileSync(legacy('roster.json'), '{"secret":"x"}');
    inject.write = (file) => {
      if (file.includes('roster.json.tmp')) {
        throw Object.assign(new Error('EACCES: {"secret":"x"}'), { code: 'EACCES' });
      }
    };

    migrateDataDir(home);

    expect(fs.existsSync(target('roster.json'))).toBe(false);
    expect(fs.existsSync(target('config.json'))).toBe(true);
    const warned = (console.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(warned).toContain('roster.json');
    expect(warned).not.toContain('secret');
  });
});

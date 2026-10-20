import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const {
  installStatusline,
  isStatuslineInstalled,
  STATUSLINE_UNSUPPORTED_PLATFORM,
  uninstallStatusline,
} = await import('../src/providers/hook/claude/claudeStatuslineInstaller.js');
const { claudeStatuslineProvider } =
  await import('../src/providers/hook/claude/claudeStatusline.js');

function settingsPath(): string {
  return path.join(tmpBase, '.claude', 'settings.json');
}

function teePath(): string {
  return path.join(tmpBase, '.pixelmates', 'hooks', 'statusline-tee.js');
}

function writeSettings(settings: Record<string, unknown>): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
}

/** A typical user status line: a script, refreshed every 30 s. */
const USER_STATUS_LINE = {
  type: 'command',
  command: '/Users/someone/.claude/statusline-command.sh',
  refreshInterval: 30,
};

describe('claudeStatuslineInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-statusline-'));
    fs.mkdirSync(path.join(tmpBase, '.claude'), { recursive: true });
    // The copy step always runs before an install; the installer only checks it happened.
    fs.mkdirSync(path.dirname(teePath()), { recursive: true });
    fs.writeFileSync(teePath(), '// bundled wrapper');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  // C3: only the command changes, every other field survives, and the uninstall puts back the exact object.
  it('chains a status line with extra fields and restores it exactly', async () => {
    writeSettings({ model: 'opus', statusLine: USER_STATUS_LINE });

    await installStatusline();

    expect(readSettings().statusLine).toEqual({
      type: 'command',
      command: `node "${teePath()}" '/Users/someone/.claude/statusline-command.sh'`,
      refreshInterval: 30,
    });
    expect(isStatuslineInstalled()).toBe(true);

    await uninstallStatusline();

    expect(readSettings()).toEqual({ model: 'opus', statusLine: USER_STATUS_LINE });
  });

  it('writes the wrapper alone when there was no status line, and removes the key again', async () => {
    writeSettings({ model: 'opus' });

    await installStatusline();
    expect(readSettings().statusLine).toEqual({ type: 'command', command: `node "${teePath()}"` });

    await uninstallStatusline();
    expect(readSettings()).toEqual({ model: 'opus' });
  });

  // C3: the restore source is the chained command. Once the user changed it, what we would write back is a guess.
  it('leaves a status line changed by hand after the install exactly as it is', async () => {
    writeSettings({ statusLine: USER_STATUS_LINE });
    await installStatusline();
    const handEdited = {
      ...readSettings(),
      statusLine: { type: 'command', command: 'bash ~/x.sh' },
    };
    writeSettings(handEdited);
    const before = fs.readFileSync(settingsPath(), 'utf-8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await uninstallStatusline();

    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(before);
    expect(log).toHaveBeenCalledWith('[pixelmates] statusLine was changed by hand; left as is.');
    expect(isStatuslineInstalled()).toBe(false);
  });

  it('never wraps its own wrapper: a second install changes nothing', async () => {
    writeSettings({ statusLine: USER_STATUS_LINE });
    await installStatusline();
    const once = fs.readFileSync(settingsPath(), 'utf-8');

    await installStatusline();

    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(once);
  });

  // C3: a file holding nothing but the wrapper we created is our own output, not the user's original.
  it('takes no backup of a file that only holds the wrapper it created', async () => {
    await installStatusline(); // no settings.json yet: the install creates it
    await uninstallStatusline();

    expect(fs.existsSync(`${settingsPath()}.pixelmates.backup`)).toBe(false);
  });

  // Each character sh would otherwise interpret, plus a newline: the original round-trips exactly, and the wrapped
  // command is still recognised as ours (otherwise uninstall would leave the wrapper behind as a hand edit).
  it('round-trips an original holding quotes, a backslash, $HOME, spaces and a newline', async () => {
    const original = `printf '%s\\n' "it's" \\
  'a "quoted" $HOME \\ path'`;
    writeSettings({ statusLine: { type: 'command', command: original } });

    await installStatusline();
    expect(isStatuslineInstalled()).toBe(true);
    await uninstallStatusline();

    expect(readSettings().statusLine).toEqual({ type: 'command', command: original });
  });

  // "Exactly one single-quoted word": a second word after it is someone else's command around ours.
  it('does not claim a wrapped command followed by another word', async () => {
    writeSettings({
      statusLine: { type: 'command', command: `node "${teePath()}" 'echo hi' extra` },
    });
    const before = fs.readFileSync(settingsPath(), 'utf-8');

    expect(isStatuslineInstalled()).toBe(false);
    await uninstallStatusline();
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(before);
  });

  // Never rewrite a shape we did not author.
  it('refuses a status line it cannot wrap, naming what it found, and writes nothing', async () => {
    writeSettings({ statusLine: { type: 'static', text: 'hello' } });
    const before = fs.readFileSync(settingsPath(), 'utf-8');

    await expect(installStatusline()).rejects.toThrow(/found keys: type, text/);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(before);
  });

  // The wrapper runs the original through sh: chained into a Windows status line, it would break it.
  it('refuses to install on Windows and leaves settings.json byte for byte', async () => {
    writeSettings({ statusLine: USER_STATUS_LINE });
    const before = fs.readFileSync(settingsPath(), 'utf-8');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    await expect(
      claudeStatuslineProvider.installHooks('http://127.0.0.1:3100', 'tok'),
    ).rejects.toThrow(STATUSLINE_UNSUPPORTED_PLATFORM);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(before);
  });

  // A chained command whose script is missing blanks the user's status line instead of running it.
  it('refuses to chain when the wrapper script is not on disk', async () => {
    writeSettings({ statusLine: USER_STATUS_LINE });
    fs.rmSync(teePath());

    await expect(installStatusline()).rejects.toThrow(/wrapper script is missing/);
    expect(readSettings().statusLine).toEqual(USER_STATUS_LINE);
  });
});

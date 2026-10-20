import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { installHooks, uninstallHooks, hasUpstreamHooks } =
  await import('../src/providers/hook/claude/claudeHookInstaller.js');
const { installStatusline, uninstallStatusline } =
  await import('../src/providers/hook/claude/claudeStatuslineInstaller.js');
const { CLAUDE_HOOK_EVENTS } = await import('../src/providers/hook/claude/constants.js');

const UPSTREAM_HOOK = (): string =>
  `node "${path.join(tmpBase, '.pixel-agents', 'hooks', 'claude-hook.js')}"`;
const UPSTREAM_TEE = (): string =>
  path.join(tmpBase, '.pixel-agents', 'hooks', 'statusline-tee.js');
const OWN_TEE = (): string => path.join(tmpBase, '.pixelmates', 'hooks', 'statusline-tee.js');
/** What the user ran before upstream wrapped it: contains a quote, so the nesting is exercised. */
const USER_COMMAND = "echo 'it''s mine' | cat";
const settingsPath = (): string => path.join(tmpBase, '.claude', 'settings.json');
const shQuote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
const UPSTREAM_WRAPPED = (): string => `node "${UPSTREAM_TEE()}" ${shQuote(USER_COMMAND)}`;

function writeLegacySettings(): void {
  const hooks: Record<string, unknown[]> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    hooks[event] = [
      { matcher: '', hooks: [{ type: 'command', command: UPSTREAM_HOOK(), timeout: 5 }] },
    ];
  }
  fs.writeFileSync(
    settingsPath(),
    JSON.stringify(
      { hooks, statusLine: { type: 'command', command: UPSTREAM_WRAPPED(), refreshInterval: 30 } },
      null,
      2,
    ),
  );
}

function read(): {
  hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  statusLine: { command: string };
} {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
}

describe('replaceLegacy: coexisting with upstream Pixel Agents', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-legacy-'));
    fs.mkdirSync(path.join(tmpBase, '.claude'), { recursive: true });
    fs.mkdirSync(path.dirname(OWN_TEE()), { recursive: true });
    fs.writeFileSync(OWN_TEE(), '// bundled wrapper');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeLegacySettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('true: one pixelmates hook per event and the tee wraps the pre-upstream command byte for byte', async () => {
    expect(hasUpstreamHooks()).toBe(true);

    await installHooks({ replaceLegacy: true });
    await installStatusline({ replaceLegacy: true });

    const { hooks, statusLine } = read();
    for (const event of CLAUDE_HOOK_EVENTS) {
      const commands = hooks[event].flatMap((e) => e.hooks.map((h) => h.command));
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain(`${path.sep}.pixelmates${path.sep}hooks`);
    }
    expect(statusLine.command).toBe(`node "${OWN_TEE()}" ${shQuote(USER_COMMAND)}`);
    expect(hasUpstreamHooks()).toBe(false);
  });

  it("false: upstream stays untouched and the tee wraps upstream's command unchanged", async () => {
    await installHooks({ replaceLegacy: false });
    await installStatusline();

    const { hooks, statusLine } = read();
    for (const event of CLAUDE_HOOK_EVENTS) {
      const commands = hooks[event].flatMap((e) => e.hooks.map((h) => h.command));
      expect(commands).toHaveLength(2);
      expect(commands).toContain(UPSTREAM_HOOK());
    }
    expect(statusLine.command).toBe(`node "${OWN_TEE()}" ${shQuote(UPSTREAM_WRAPPED())}`);

    // Undoing ours returns upstream's wrapped command exactly.
    await uninstallStatusline();
    expect(read().statusLine.command).toBe(UPSTREAM_WRAPPED());
  });

  it('uninstall with only upstream entries present leaves settings.json byte-identical', async () => {
    const before = fs.readFileSync(settingsPath(), 'utf-8');

    await uninstallHooks();
    await uninstallStatusline();

    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(before);
  });
});

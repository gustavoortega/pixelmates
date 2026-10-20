import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { CliArgsError, parseArgs } from '../src/cli.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';

const CLI_BUNDLE = path.join(__dirname, '../../dist/cli.js');
const CLI_START_TIMEOUT_MS = 10_000;

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a test port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  timeoutMs = CLI_START_TIMEOUT_MS,
  what = 'bundled CLI startup',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('close', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

/** Run the real bundled CLI as a subprocess, returns exit code + output. */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_BUNDLE, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('parseArgs', () => {
  // 1. No --port -> unset (the saved port, else an OS-assigned one), never a hardcoded port
  it('defaults port to undefined (saved or OS-assigned) when --port is omitted', () => {
    const args = parseArgs([]);
    expect(args.port).toBeUndefined();
    expect(args.host).toBe('127.0.0.1');
  });

  // 2. Valid --port is accepted
  it('accepts a valid --port', () => {
    expect(parseArgs(['--port', '3100']).port).toBe(3100);
    expect(parseArgs(['-p', '8080']).port).toBe(8080);
  });

  // 3. Boundary values are accepted
  it('accepts the boundary ports 1 and 65535', () => {
    expect(parseArgs(['--port', '1']).port).toBe(1);
    expect(parseArgs(['--port', '65535']).port).toBe(65535);
  });

  // 4. Non-numeric --port is rejected (would otherwise become NaN)
  it('rejects a non-numeric --port instead of producing NaN', () => {
    expect(() => parseArgs(['--port', 'not-a-number'])).toThrow(CliArgsError);
  });

  // 5. Zero is rejected (0 means "ephemeral" internally; not a valid explicit choice)
  it('rejects --port 0', () => {
    expect(() => parseArgs(['--port', '0'])).toThrow(CliArgsError);
  });

  // 6. Out-of-range (too high) is rejected
  it('rejects --port 70000 (out of TCP range)', () => {
    expect(() => parseArgs(['--port', '70000'])).toThrow(CliArgsError);
  });

  // 7. Negative is rejected
  it('rejects a negative --port', () => {
    expect(() => parseArgs(['--port', '-1'])).toThrow(CliArgsError);
  });

  // 8. Non-integer (decimal) is rejected
  it('rejects a decimal --port', () => {
    expect(() => parseArgs(['--port', '3100.5'])).toThrow(CliArgsError);
  });

  // 9. A port option without its required operand is rejected, not ignored
  it.each(['--port', '-p'])('rejects %s when its value is missing', (option) => {
    expect(() => parseArgs([option])).toThrow(CliArgsError);
    expect(() => parseArgs([option])).toThrow(/Missing value/);
  });

  // 10. --host is parsed independently of --port
  it('parses --host', () => {
    expect(parseArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
  });

  /** The CliArgsError message parseArgs throws for `argv`, or 'accepted'. */
  const rejection = (argv: string[]): string => {
    try {
      parseArgs(argv);
    } catch (err) {
      if (err instanceof CliArgsError) return err.message;
    }
    return 'accepted';
  };

  // --token is a bearer secret in the printed URL: 16-128 URL-safe characters, and a
  // rejected value is never echoed back to the terminal.
  it('accepts a 16-128 character URL-safe --token and rejects anything else', () => {
    expect(parseArgs(['--token', 'Ab0._-Ab0._-Ab0.']).token).toBe('Ab0._-Ab0._-Ab0.');
    expect(parseArgs(['--token', 'a'.repeat(128)]).token).toBe('a'.repeat(128));
    for (const value of ['a'.repeat(15), 'a'.repeat(129), 'secret-but-unsafe!']) {
      const message = rejection(['--token', value]);
      expect(message).toMatch(/^invalid --token/);
      expect(message).not.toContain(value);
    }
    expect(rejection(['--token'])).toMatch(/^invalid --token/);
  });

  // 11. Unknown flags are ignored, so without its parse branch --new-token
  //     would be a silent no-op and the old token would stay valid. Next to
  //     --token, which leaves the saved token alone, it would be one too.
  it('parses --new-token, off by default, and refuses it next to --token', () => {
    expect(parseArgs([]).newToken).toBe(false);
    expect(parseArgs(['--new-token']).newToken).toBe(true);
    const given = 'given-token-0123456789';
    for (const argv of [
      ['--token', given, '--new-token'],
      ['--new-token', '--token', given],
    ]) {
      const message = rejection(argv);
      expect(message).toMatch(/--token and --new-token/);
      expect(message).not.toContain(given);
    }
  });
});

// The TTY consent prompt is gone: first-run consent is asked in the app, as
// one step of the Intro (the server's hooksConsentRequest → the webview's
// IntroBubble, whose consent step renders it verbatim). Its two pinned
// semantics moved with it: "junk must never be read as approval" now lives in
// consentFlow.test.ts (an unrecognized hooksConsentResponse choice
// writes nothing), and the disclosure-content pins live in consentCopy.test.ts
// plus the handshake test asserting the request carries that copy verbatim.

/**
 * These spawn the real bundled dist/cli.js (built by esbuild), not the TS
 * source -- unlike the parseArgs tests above (which only prove importing the
 * module for its exports is side-effect-free), these prove the
 * `require.main === module` guard added to cli.ts still lets `main()` run
 * when the file IS executed directly, i.e. production behavior is intact.
 * Requires `npm run compile` (or `node esbuild.js`) to have produced
 * dist/cli.js first; reported as a loud skip if it hasn't.
 */
describe('dist/cli.js entry-point guard', () => {
  /** These tests spawn the BUNDLED CLI, so they need `npm run compile` to have
   *  run. Reported as a loud skip rather than an early `return`, which Vitest
   *  shows as PASSED with no message — a false green over a test that never
   *  exercised anything. */
  const itBuilt = it.skipIf(!fs.existsSync(CLI_BUNDLE));

  // 11. Direct execution still runs main() (--help exits 0 with usage)
  itBuilt('runs main() when executed directly: --help prints usage and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: pixelmates');
  });

  // 12. Direct execution still runs main()'s port validation (rejects before listen())
  itBuilt(
    'runs main() when executed directly: invalid --port exits 1 without starting a server',
    async () => {
      const { code, stderr } = await runCli(['--port', 'not-a-number']);
      expect(code).toBe(1);
      expect(stderr).toContain('Invalid --port');
    },
  );

  /** Spawn the real bundled CLI against an isolated HOME, wait for /api/health,
   *  and hand back its output for assertions. Callers seed `tmpHome` first.
   *  `host` is the literal `--host` operand, so a caller can exercise a wildcard
   *  bind; readiness is always probed over loopback, which every bind serves.
   *  stdout and stderr are kept apart so a stderr chunk can never land inside
   *  a JSON log line; `output()` joins them for substring checks. */
  async function runCliServer(
    tmpHome: string,
    body: (ctx: {
      output: () => string;
      stdout: () => string;
      stderr: () => string;
      port: number;
    }) => Promise<void>,
    host = '127.0.0.1',
    extraArgs: string[] = [],
  ): Promise<void> {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-workspace-'));
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      [CLI_BUNDLE, '--port', port.toString(), '--host', host, ...extraArgs],
      {
        cwd: workspaceDir,
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const output = (): string => `${stdout}\n${stderr}`;
    try {
      await waitForCondition(async () => {
        if (child.exitCode !== null) {
          throw new Error(`Bundled CLI exited before startup:\n${output()}`);
        }
        try {
          return (await fetch(`http://127.0.0.1:${port.toString()}/api/health`)).ok;
        } catch {
          return false;
        }
      });
      await body({ output, stdout: () => stdout, stderr: () => stderr, port });
    } finally {
      await stopChild(child);
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  /** The one line a standalone operator ever sees. Kept as a real regex over
   *  the real stdout, because a helper that reassembled the URL from parts
   *  would be testing the helper. The trailing `\s` makes it wait for a
   *  complete line: stdout arrives in chunks, and a half-delivered URL still
   *  parses as a URL (`http://127.0.0.1:501`). */
  const URL_LINE = /pixelmates server running at (\S+)\s/;

  function printedUrl(output: string): URL {
    const match = URL_LINE.exec(output);
    if (!match?.[1]) throw new Error(`No server URL in CLI output:\n${output}`);
    return new URL(match[1]);
  }

  /** A Fastify "incoming request" JSON log line whose url shows the redaction. */
  function isRedactedRequestLine(line: string): boolean {
    if (!line.startsWith('{')) return false;
    try {
      const entry = JSON.parse(line) as { msg?: unknown; req?: { url?: unknown } };
      return (
        entry.msg === 'incoming request' &&
        typeof entry.req?.url === 'string' &&
        entry.req.url.includes('[redacted]')
      );
    } catch {
      return false; // a line still being written
    }
  }

  /** The token the server actually minted, read from its own discovery file —
   *  an independent witness, so a printed token that drifts from it fails. */
  function mintedToken(tmpHome: string): string {
    const raw = fs.readFileSync(path.join(tmpHome, '.pixelmates', 'server.json'), 'utf-8');
    return (JSON.parse(raw) as { token: string }).token;
  }

  // Coming from upstream Pixel Agents: booting the real entry against a populated ~/.pixel-agents performs the one-time
  // copy, and what belongs to the other app (its token, its hooks) stays there.
  itBuilt('copies the office from ~/.pixel-agents on first boot', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-migrate-'));
    const legacy = path.join(tmpHome, '.pixel-agents');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'layout.json'), '{"version":1,"cols":3}');
    fs.writeFileSync(path.join(legacy, 'config.json'), '{"hooksConsent":{"claude":"granted"}}');
    fs.writeFileSync(path.join(legacy, 'server-token'), 'upstream-token-0123456789');
    await runCliServer(tmpHome, async ({ output }) => {
      expect(fs.readFileSync(path.join(tmpHome, '.pixelmates', 'layout.json'), 'utf-8')).toBe(
        '{"version":1,"cols":3}',
      );
      expect(output()).toContain('Copied your office from ~/.pixel-agents (2 files).');
      expect(fs.existsSync(path.join(legacy, 'server-token'))).toBe(true);
      const minted = fs.readFileSync(path.join(tmpHome, '.pixelmates', 'server-token'), 'utf-8');
      expect(minted.trim()).not.toBe('upstream-token-0123456789');
    });
  });

  // The printed URL is the ONLY channel by which a real browser obtains the
  // token, and the token is the whole privilege gate (httpServer.ts
  // standaloneTokenValid). A bare URL, or one carrying the wrong token, ships a
  // silently read-only session: the office renders, and the hooks toggle is
  // refused with no way for the operator to find out why. Nothing else in this
  // repo reads the CLI's stdout, so nothing else can catch that.
  itBuilt('prints a URL carrying the token the server actually minted', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-url-'));
    await runCliServer(tmpHome, async ({ output, stdout, stderr, port }) => {
      await waitForCondition(() => URL_LINE.test(output()));
      const url = printedUrl(output());

      const token = mintedToken(tmpHome);
      expect(url.searchParams.get('token')).toBe(token);
      expect(url.port).toBe(port.toString());
      // And it is browsable as printed — the SPA, not a 404 or a dead host.
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<div id="root">');

      // That request also lands in the JSON request log, whose write is not
      // ordered with the response: wait for its line, redacted, or a check
      // over a log that has not caught up yet proves nothing. The printed URL
      // line above is the one place the token may appear.
      await waitForCondition(
        () => stdout().split('\n').some(isRedactedRequestLine),
        3_000,
        'a redacted "incoming request" log line',
      );
      const logLines = [...stdout().split('\n'), ...stderr().split('\n')].filter((line) =>
        line.startsWith('{'),
      );
      for (const line of logLines) expect(line).not.toContain(token);
    });
  });

  // --token pins the URL for a run (the e2e hosts restart with it) and must leave the
  // saved token alone: the next plain start still serves the tabs it printed for.
  itBuilt(
    'serves and prints the --token it was given and leaves the saved token alone',
    async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-token-'));
      const tokenFile = path.join(tmpHome, '.pixelmates', 'server-token');
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, 'saved-token-0123456789');
      const given = 'given-token-0123456789';
      await runCliServer(
        tmpHome,
        async ({ output }) => {
          await waitForCondition(() => URL_LINE.test(output()));
          expect(printedUrl(output()).searchParams.get('token')).toBe(given);
          expect(mintedToken(tmpHome)).toBe(given);
          expect(fs.readFileSync(tokenFile, 'utf-8')).toBe('saved-token-0123456789');
        },
        '127.0.0.1',
        ['--token', given],
      );
    },
  );

  // --new-token revokes every URL the saved token was printed in: the run serves and
  // prints a fresh token and saves it, so the next plain start serves the new URL.
  itBuilt('serves, prints and saves a new token on --new-token', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-new-token-'));
    const tokenFile = path.join(tmpHome, '.pixelmates', 'server-token');
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, 'saved-token-0123456789');
    await runCliServer(
      tmpHome,
      async ({ output }) => {
        await waitForCondition(() => URL_LINE.test(output()));
        const printed = printedUrl(output()).searchParams.get('token');
        expect(printed).not.toBe('saved-token-0123456789');
        expect(printed).toBe(mintedToken(tmpHome));
        expect(fs.readFileSync(tokenFile, 'utf-8')).toBe(printed);
      },
      '127.0.0.1',
      ['--new-token'],
    );
  });

  // `--host 0.0.0.0` is a BIND target, not an address to browse to: printing
  // `http://0.0.0.0:PORT` hands the operator a URL that is dead on Windows and
  // merely accidental elsewhere (macOS happens to route it to loopback, so
  // "does it load" alone would not catch this — hence the explicit check that
  // the DISPLAYED host is a loopback address). `::` and `''` take the same
  // branch and are left untested here: binding them needs IPv6 on the runner,
  // which is not a property of ours to depend on.
  itBuilt('prints a reachable loopback host when bound to the 0.0.0.0 wildcard', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-wildcard-'));
    await runCliServer(
      tmpHome,
      async ({ output }) => {
        await waitForCondition(() => URL_LINE.test(output()));
        const url = printedUrl(output());

        expect(url.hostname).not.toBe('0.0.0.0');
        expect(['127.0.0.1', 'localhost', '[::1]', '::1']).toContain(url.hostname);
        // The wildcard bind must not cost the operator the token either.
        expect(url.searchParams.get('token')).toBe(mintedToken(tmpHome));
        expect((await fetch(url)).status).toBe(200);
      },
      '0.0.0.0',
    );
  });

  // Without consent the CLI must start normally and touch nothing — the ask
  // happens in the browser UI, never at startup. This is the inverse of the
  // seeded test below: it pins that the gate actually gates, rather than the
  // install happening to work.
  itBuilt('starts without touching settings.json when consent has not been given', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-noconsent-'));
    await runCliServer(tmpHome, async ({ output }) => {
      // Give the startup consent/install path time to have run (it is awaited
      // before the "server running" line, which health readiness follows).
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.existsSync(path.join(tmpHome, '.claude', 'settings.json'))).toBe(false);
      expect(output()).toContain('needs one-time approval');
    });
  });

  // An existing user whose hooks a pre-consent version installed gets ZERO
  // friction: no prompt, just the migration. The startup install is the 14 -> 12
  // migration and it only ever REDUCES scope (UserPromptSubmit and TaskCreated,
  // the two events that forwarded prompt text, go away), so asking would buy
  // this user nothing they do not already have. What it must NOT do is take the
  // opportunity to touch anything else: unrelated settings keys and a
  // third-party hook sharing one of our entries both survive intact.
  itBuilt('migrates a pre-consent install to 12 events with no prompt', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-legacy-'));
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    // A legacy install: our command on every event we install today, plus the
    // two we no longer do.
    const ourCommand = `node "${path.join(tmpHome, '.pixelmates', 'hooks', 'claude-hook.js')}"`;
    const thirdPartyCommand = 'node /elsewhere/other-tool.js';
    const legacyEvents = [...CLAUDE_HOOK_EVENTS, 'UserPromptSubmit', 'TaskCreated'];
    const hooks = Object.fromEntries(
      legacyEvents.map((event) => [
        event,
        [{ matcher: '', hooks: [{ type: 'command', command: ourCommand, timeout: 5 }] }],
      ]),
    ) as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    // A third-party hook sharing the entry of an event we are dropping: the
    // sweep must take ours out of it and leave theirs.
    hooks['UserPromptSubmit'][0].hooks.unshift({ command: thirdPartyCommand });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks }, null, 2),
    );

    await runCliServer(tmpHome, async ({ output }) => {
      await waitForCondition(() => output().includes('[pixelmates] Hooks installed'));
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        permissions?: unknown;
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const ourEvents = Object.entries(after.hooks)
        .filter(([, entries]) => entries.some((e) => e.hooks.some((h) => h.command === ourCommand)))
        .map(([event]) => event)
        .sort();
      expect(ourEvents).toEqual([...CLAUDE_HOOK_EVENTS].sort());
      expect(ourEvents).not.toContain('UserPromptSubmit');
      expect(ourEvents).not.toContain('TaskCreated');
      // Untouched neighbours: an unrelated top-level key, and the third-party
      // hook that shared the entry we swept.
      expect(after.permissions).toEqual({ allow: ['Bash(ls:*)'] });
      expect(after.hooks['UserPromptSubmit'][0].hooks).toEqual([{ command: thirdPartyCommand }]);
      // TaskCreated held only ours -> emptied and the key removed entirely.
      expect(after.hooks['TaskCreated']).toBeUndefined();

      const configPath = path.join(tmpHome, '.pixelmates', 'config.json');
      const consent = (
        JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
          hooksConsent?: Record<string, string>;
        }
      ).hooksConsent?.claude;
      expect(consent).toBe('granted');

      // ZERO friction: nothing that reads as a question or a deferral was
      // printed. The prompt headline, the [Y/n/never] question, and both
      // no-consent notices would each be a prompt this user must not see.
      expect(output()).not.toContain('needs to add its hooks');
      expect(output()).not.toContain('[Y/n/never]');
      expect(output()).not.toContain('needs one-time approval');
      expect(output()).not.toContain('asked again next time');
    });
  });

  // W5: the hook script is copied BEFORE the settings entries, and a failed
  // copy aborts the install. An entry pointing at a script that does not exist
  // makes Claude Code spawn a dead `node` for every event — worse than nothing.
  // A regular file where the hooks DIRECTORY belongs makes the copy fail
  // (ENOTDIR) without touching the repo's real dist/.
  itBuilt('writes no hook entries when the hook script cannot be copied', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-nocopy-'));
    fs.mkdirSync(path.join(tmpHome, '.pixelmates'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.pixelmates', 'config.json'),
      JSON.stringify({ hooksConsent: { claude: 'granted' } }),
    );
    // hooks/ is a FILE, so copying into hooks/claude-hook.js fails.
    fs.writeFileSync(path.join(tmpHome, '.pixelmates', 'hooks'), 'not a directory');

    await runCliServer(tmpHome, async ({ output }) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.existsSync(path.join(tmpHome, '.claude', 'settings.json'))).toBe(false);
      expect(output()).toContain('Hooks NOT installed');
      expect(output()).not.toContain('[pixelmates] Hooks installed');
    });
  });

  itBuilt('installs the bundled hook script from the package root on startup', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-home-'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-workspace-'));
    // The spawned CLI has no TTY, and without prior consent the first-run gate
    // (rightly) skips hook installation there — seed consent so this test can
    // exercise the actual install path.
    fs.mkdirSync(path.join(tmpHome, '.pixelmates'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.pixelmates', 'config.json'),
      JSON.stringify({ hooksConsent: { claude: 'granted' } }),
    );
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      [CLI_BUNDLE, '--port', port.toString(), '--host', '127.0.0.1'],
      {
        cwd: workspaceDir,
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    try {
      await waitForCondition(async () => {
        if (child.exitCode !== null) {
          throw new Error(`Bundled CLI exited before startup:\n${output}`);
        }
        try {
          return (await fetch(`http://127.0.0.1:${port.toString()}/api/health`)).ok;
        } catch {
          return false;
        }
      });

      const installedHook = path.join(tmpHome, '.pixelmates', 'hooks', 'claude-hook.js');
      await waitForCondition(() => fs.existsSync(installedHook));
      expect(fs.readFileSync(installedHook, 'utf-8')).toContain('#!/usr/bin/env node');
      if (process.platform !== 'win32') {
        expect(fs.statSync(installedHook).mode & 0o100).toBeTruthy();
      }

      const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(settings)).toContain(installedHook);
    } finally {
      await stopChild(child);
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

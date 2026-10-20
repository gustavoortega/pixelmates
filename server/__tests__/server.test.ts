import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerConfig } from '../src/serverConfig.js';

// Use isolated temp HOME to avoid touching real ~/.pixelmates/
let tmpBase: string;
let serverJsonDir: string;
let serverJsonPath: string;
let registryDir: string;

/** List registry entry files (excludes .tmp write-in-progress artifacts). */
function registryFiles(): string[] {
  try {
    return fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

// Must import AFTER mock setup
const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { UsageLimitsStore } = await import('../src/usage/usageLimitsStore.js');

async function postHook(
  port: number,
  token: string,
  body: string,
  providerId = 'claude',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/hooks/${providerId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}

/**
 * A hook POST that declares a `contentLength` body and sends only its headers,
 * resolving with the status the server answers before reading any of it, or 0
 * if it waits for the body instead. Sending a body the server refuses to read
 * races its answer: after a 413 Fastify closes the connection, which resets a
 * client still writing and can drop the response it already sent.
 */
function postDeclaredLength(port: number, contentLength: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/hooks/claude',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': contentLength.toString(),
        Authorization: `Bearer ${token}`,
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve(0);
    }, 2_000);
    req.on('response', (res) => {
      clearTimeout(timer);
      resolve(res.statusCode ?? 0);
      res.resume();
      req.destroy();
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.flushHeaders();
  });
}

/** The error code binding 127.0.0.1:`port` fails with right now, or undefined if it binds. */
function listenErrorCode(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(undefined)));
  });
}

describe('PixelAgentsServer', () => {
  let server: InstanceType<typeof PixelAgentsServer>;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-server-test-'));
    serverJsonDir = path.join(tmpBase, '.pixelmates');
    serverJsonPath = path.join(serverJsonDir, 'server.json');
    registryDir = path.join(serverJsonDir, 'servers');
    fs.mkdirSync(serverJsonDir, { recursive: true });
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. Server starts and returns config
  it('starts and returns config with port, token, pid', async () => {
    const config = await server.start();
    expect(config.port).toBeGreaterThan(0);
    expect(config.token).toBeTruthy();
    expect(config.pid).toBe(process.pid);
    expect(config.startedAt).toBeGreaterThan(0);
  });

  // 2. Health endpoint returns 200 + uptime
  it('health endpoint returns 200 with uptime', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number; pid: number };
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.pid).toBe(process.pid);
  });

  // 3. Hook endpoint requires auth
  it('hook endpoint returns 401 without auth', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/claude`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  // 4. Hook endpoint accepts valid auth
  it('hook endpoint returns 200 with valid auth', async () => {
    const config = await server.start();
    const res = await postHook(
      config.port,
      config.token,
      JSON.stringify({ session_id: 'test', hook_event_name: 'Stop' }),
    );
    expect(res.status).toBe(200);
  });

  // 5. Hook callback fires on valid event
  it('hook callback fires on valid event', async () => {
    const config = await server.start();
    const received: Array<{ providerId: string; event: Record<string, unknown> }> = [];
    server.onHookEvent((providerId: string, event: Record<string, unknown>) => {
      received.push({ providerId, event });
    });

    await postHook(
      config.port,
      config.token,
      JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].providerId).toBe('claude');
    expect(received[0].event.session_id).toBe('abc');
    expect(received[0].event.hook_event_name).toBe('Stop');
  });

  // 6. Hook bodies carry whole Write and Edit payloads: at the old 64 KB limit
  //    a big Write got a 413 and its tool start never reached the runtime.
  it('hook endpoint hands a 900 KB Write event to the runtime', async () => {
    const config = await server.start();
    const onHookEvent = vi.fn();
    server.onHookEvent(onHookEvent);
    const content = 'x'.repeat(921_000);

    const res = await postHook(
      config.port,
      config.token,
      JSON.stringify({
        session_id: 's1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/a', content },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(onHookEvent).toHaveBeenCalledTimes(1);
    expect(onHookEvent.mock.calls[0][1]).toMatchObject({ tool_input: { content } });
  });

  // 6b. The limit still holds above 1 MiB.
  it('hook endpoint returns 413 for a body declared at 2 MiB', async () => {
    const config = await server.start();
    expect(await postDeclaredLength(config.port, 2_097_152, config.token)).toBe(413);
  });

  // 6c. The token is checked before the body is read: under --host 0.0.0.0 any
  //     client past the Host check could otherwise make the server buffer and
  //     parse up to 1 MiB per request without it. Read first, this invalid
  //     JSON would be a 400.
  it('hook endpoint answers a wrong token 401 before parsing the body', async () => {
    const config = await server.start();
    const res = await postHook(config.port, 'wrong', 'x'.repeat(921_600));
    expect(res.status).toBe(401);
  });

  // 7. Hook endpoint rejects invalid JSON
  it('hook endpoint returns 400 for invalid JSON', async () => {
    const config = await server.start();
    const res = await postHook(config.port, config.token, 'not json {{{');
    expect(res.status).toBe(400);
  });

  // 8. Hook endpoint rejects missing provider ID
  it('hook endpoint returns 400 for missing provider ID', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  // 9. server.json written
  it('writes server.json with port, pid, token', async () => {
    const config = await server.start();
    const json = JSON.parse(fs.readFileSync(serverJsonPath, 'utf-8'));
    expect(json.port).toBe(config.port);
    expect(json.pid).toBe(process.pid);
    expect(json.token).toBe(config.token);
  });

  // 10. Registry entry written alongside the legacy server.json
  it('writes a registry entry with port, pid, servesSpa, protocol', async () => {
    const config = await server.start();
    const files = registryFiles();
    expect(files).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(registryDir, files[0]), 'utf-8'));
    expect(entry.port).toBe(config.port);
    expect(entry.pid).toBe(process.pid);
    expect(entry.token).toBe(config.token);
    expect(entry.servesSpa).toBe(false); // embedded (default) never serves the SPA
    expect(typeof entry.protocol).toBe('number');
  });

  // 11. Second instance, same capability (embedded+embedded), reuses existing server
  it('second embedded instance reuses an existing embedded server', async () => {
    const config1 = await server.start({ embedded: true });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: true });
    expect(config2.port).toBe(config1.port);
    expect(config2.pid).toBe(config1.pid);
    expect(registryFiles()).toHaveLength(1); // reuse -- server2 wrote no entry of its own
    server2.stop(); // should not delete server.json / the registry entry (not owner)
  });

  // 12. Second instance, same capability (standalone+standalone), reuses existing server
  it('second standalone instance reuses an existing standalone server', async () => {
    const config1 = await server.start({ embedded: false });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: false });
    expect(config2.port).toBe(config1.port);
    expect(registryFiles()).toHaveLength(1);
    server2.stop();
  });

  // 13. Capability mismatch: a standalone caller never reuses an embedded server
  it('standalone does not reuse an existing embedded server; starts its own', async () => {
    const config1 = await server.start({ embedded: true });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: false });
    expect(config2.port).not.toBe(config1.port);
    expect(registryFiles()).toHaveLength(2);
    server2.stop();
  });

  // 14. Capability mismatch, mirrored: an embedded caller never reuses a standalone server
  it('embedded does not reuse an existing standalone server; starts its own', async () => {
    const config1 = await server.start({ embedded: false });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: true });
    expect(config2.port).not.toBe(config1.port);
    expect(registryFiles()).toHaveLength(2);
    server2.stop();
  });

  // 15. Embedded + standalone coexist: two independent live registry entries, neither reuses
  it('embedded and standalone servers coexist as two live registry entries', async () => {
    const embeddedConfig = await server.start({ embedded: true });
    const standalone = new PixelAgentsServer();
    const standaloneConfig = await standalone.start({ embedded: false });

    expect(standaloneConfig.port).not.toBe(embeddedConfig.port);
    expect(standaloneConfig.token).not.toBe(embeddedConfig.token);
    const files = registryFiles();
    expect(files).toHaveLength(2);
    const entries = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(registryDir, f), 'utf-8')),
    );
    expect(entries.some((e) => e.servesSpa === false && e.port === embeddedConfig.port)).toBe(true);
    expect(entries.some((e) => e.servesSpa === true && e.port === standaloneConfig.port)).toBe(
      true,
    );

    standalone.stop();
  });

  // A standalone tab carries the token in its URL: a restart minting a new one would
  // refuse every open tab (4001), so the token is saved and reused. Embedded keeps a
  // per-start token of its own (test 15 pins that the two differ).
  it('a standalone server reuses its saved token across restarts', async () => {
    const first = await server.start({ embedded: false });
    server.stop();
    server = new PixelAgentsServer();
    const second = await server.start({ embedded: false });

    expect(second.token).toBe(first.token);
    expect(fs.readFileSync(path.join(serverJsonDir, 'server-token'), 'utf-8')).toBe(first.token);
  });

  // 16. Dead-pid registry entries are pruned on start, never reused
  it('prunes dead-pid registry entries on start instead of reusing them', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const staleFile = path.join(registryDir, '999999-9999.json');
    fs.writeFileSync(
      staleFile,
      JSON.stringify({
        port: 9999,
        pid: 999999,
        token: 'stale',
        startedAt: 0,
        servesSpa: false,
        protocol: 1,
      }),
    );

    const config = await server.start({ embedded: true });

    expect(fs.existsSync(staleFile)).toBe(false); // pruned, not left behind
    expect(config.port).not.toBe(9999); // never reused the dead entry -- started its own
    expect(registryFiles()).toHaveLength(1); // only the freshly-started server's entry remains
  });

  // 17. Structurally invalid live-pid entries are malformed, not reusable
  it('prunes a structurally invalid live-pid entry instead of reusing it', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const malformedFile = path.join(registryDir, `${process.pid}-70000.json`);
    fs.writeFileSync(
      malformedFile,
      JSON.stringify({
        port: 70_000,
        pid: process.pid,
        token: 'invalid-port',
        startedAt: Date.now(),
        servesSpa: false,
        protocol: 1,
      }),
    );

    const config = await server.start({ embedded: true });

    expect(config.port).not.toBe(70_000);
    expect(fs.existsSync(malformedFile)).toBe(false);
    expect(registryFiles()).toHaveLength(1);
  });

  // 18. server.json cleaned up on stop
  it('deletes server.json on stop', async () => {
    await server.start();
    expect(fs.existsSync(serverJsonPath)).toBe(true);
    server.stop();
    expect(fs.existsSync(serverJsonPath)).toBe(false);
  });

  // 19. server.json NOT deleted if PID mismatch
  it('does not delete server.json if PID mismatch', async () => {
    // Write fake server.json with different PID
    fs.writeFileSync(
      serverJsonPath,
      JSON.stringify({ port: 9999, pid: 999999, token: 'fake', startedAt: 0 }),
    );
    // Server never started (it would reuse), just stop
    const server2 = new PixelAgentsServer();
    server2.stop();
    expect(fs.existsSync(serverJsonPath)).toBe(true);
  });

  // 20. stop() removes only this server's own registry entry, preserves the other's (D6)
  it('deletes only its own registry entry on stop, preserving a coexisting server', async () => {
    const embeddedConfig = await server.start({ embedded: true });
    const standalone = new PixelAgentsServer();
    const standaloneConfig = await standalone.start({ embedded: false });
    expect(registryFiles()).toHaveLength(2);

    standalone.stop();

    // Only the standalone's own entry is gone; the still-running embedded
    // server's registry entry is untouched (self-only cleanup, D6).
    const remaining = registryFiles().map(
      (f) => JSON.parse(fs.readFileSync(path.join(registryDir, f), 'utf-8')) as { port: number },
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].port).toBe(embeddedConfig.port);
    expect(remaining.some((e) => e.port === standaloneConfig.port)).toBe(false);
  });

  // 21. Unknown route returns 404
  it('unknown route returns 404', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/random/path`);
    expect(res.status).toBe(404);
  });

  // 22. Hook callback does NOT fire for events missing required fields
  it('hook callback does not fire for events without session_id', async () => {
    const config = await server.start();
    const received: unknown[] = [];
    server.onHookEvent((_pid: string, event: Record<string, unknown>) => received.push(event));

    await postHook(
      config.port,
      config.token,
      JSON.stringify({ hook_event_name: 'Stop' }), // missing session_id
    );

    expect(received).toHaveLength(0);
  });

  // C4: the status line wrapper's ingress takes the hook token and nothing but the two windows.
  describe('POST /api/statusline/:providerId', () => {
    const LIMITS = {
      fiveHour: { usedPercentage: 37.5, resetsAt: 1_760_000_000 },
      sevenDay: { usedPercentage: 12, resetsAt: 1_760_400_000 },
    };

    async function startWithLimits(): Promise<{
      port: number;
      token: string;
      limits: InstanceType<typeof UsageLimitsStore>;
    }> {
      const limits = new UsageLimitsStore(new AgentStateStore());
      const config = await server.start({ usageLimits: limits });
      return { port: config.port, token: config.token, limits };
    }

    function postLimits(port: number, token: string | null, body: unknown): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/api/statusline/claude-statusline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token !== null && { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
    }

    it('refuses a post without the bearer token', async () => {
      const { port, limits } = await startWithLimits();

      const res = await postLimits(port, null, LIMITS);

      expect(res.status).toBe(401);
      expect(limits.latest().receivedAt).toBe(0);
    });

    it('accepts the two windows and hands them to the store', async () => {
      const { port, token, limits } = await startWithLimits();

      const res = await postLimits(port, token, LIMITS);

      expect(res.status).toBe(200);
      expect(limits.latest()).toMatchObject({
        fiveHour: { usedPercentage: 37.5, resetsAt: 1_760_000_000_000 },
        sevenDay: { usedPercentage: 12, resetsAt: 1_760_400_000_000 },
      });
    });

    it.each([
      ['a body carrying more than the two windows', { ...LIMITS, cwd: '/home/someone/repo' }],
      [
        'an out-of-range percentage',
        { ...LIMITS, fiveHour: { ...LIMITS.fiveHour, usedPercentage: 5000 } },
      ],
      ['two null windows', { fiveHour: null, sevenDay: null }],
    ])('answers 400 to %s and stores nothing', async (_case, body) => {
      const { port, token, limits } = await startWithLimits();

      const res = await postLimits(port, token, body);

      expect(res.status).toBe(400);
      expect(limits.latest().receivedAt).toBe(0);
    });

    // The twin of test 6c: this ingress also checks the token before it reads a body.
    it('answers a wrong token 401 before parsing the body', async () => {
      const { port, limits } = await startWithLimits();

      const res = await fetch(`http://127.0.0.1:${port}/api/statusline/claude-statusline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
        body: 'x'.repeat(921_600),
      });

      expect(res.status).toBe(401);
      expect(limits.latest().receivedAt).toBe(0);
    });
  });

  // ── ~/.pixelmates/server-token and server-port: the standalone URL across restarts ──

  function tokenFile(): string {
    return path.join(serverJsonDir, 'server-token');
  }

  function portFile(): string {
    return path.join(serverJsonDir, 'server-port');
  }

  /** A standalone run that has already exited. stop() leaves Fastify's close to
   *  the event loop, so wait until its port can be bound again: a restart that
   *  found it still taken would fall back and prove nothing about reuse. */
  async function previousStandaloneRun(): Promise<ServerConfig> {
    const config = await server.start({ embedded: false });
    server.stop();
    const deadline = Date.now() + 5_000;
    while ((await listenErrorCode(config.port)) !== undefined) {
      if (Date.now() > deadline) throw new Error(`port ${config.port} was never released`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return config;
  }

  /** What crypto.randomUUID() mints. */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  // 23. A bookmarked URL keeps its port too (the token is the test above).
  it('restarts a standalone server on the port it picked for itself', async () => {
    const first = await previousStandaloneRun();

    const second = await server.start({ embedded: false });

    expect(second.port).toBe(first.port);
    expect(fs.readFileSync(portFile(), 'utf-8')).toBe(String(first.port));
  });

  // 24. --new-token revokes old URLs without moving the server.
  it('saves a new token over the old one on newToken and keeps the port', async () => {
    const first = await previousStandaloneRun();

    const rotated = await server.start({ embedded: false, newToken: true });

    expect(rotated.token).toMatch(UUID);
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.port).toBe(first.port);
    expect(fs.readFileSync(tokenFile(), 'utf-8')).toBe(rotated.token);
    // The file holds a long-lived bearer token.
    if (process.platform !== 'win32') {
      expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
    }
  });

  // 25. A taken saved port must not fail the start, and must not be forgotten
  //     either: the next start tries it again.
  it('falls back from a taken saved port and keeps it saved', async () => {
    const first = await previousStandaloneRun();
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(first.port, '127.0.0.1', () => resolve());
    });

    try {
      const second = await server.start({ embedded: false });

      expect(second.port).not.toBe(first.port);
      expect(fs.readFileSync(portFile(), 'utf-8')).toBe(String(first.port));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  // 26. The embedded token reaches hook scripts through server.json only: saved,
  //     it would become a long-lived credential, and the standalone one must not
  //     open the embedded server either. Nor may embedded take the standalone's port.
  it('never reads or writes the token or port file from an embedded server', async () => {
    await server.start({ embedded: true });
    expect(fs.existsSync(tokenFile())).toBe(false);
    expect(fs.existsSync(portFile())).toBe(false);
    server.stop();

    // Below every OS-assigned range, so only a read of the file could pick it.
    fs.writeFileSync(tokenFile(), 'saved-token-0123456789');
    fs.writeFileSync(portFile(), '23456');
    const config = await server.start({ embedded: true });
    expect(config.token).not.toBe('saved-token-0123456789');
    expect(config.port).not.toBe(23456);
    expect(fs.readFileSync(tokenFile(), 'utf-8')).toBe('saved-token-0123456789');
    expect(fs.readFileSync(portFile(), 'utf-8')).toBe('23456');
  });

  // 27. An explicit port is for that run only, so test and e2e runs, which
  //     always pass one, never move a user's saved port.
  it('serves an explicit port without saving it', async () => {
    const first = await previousStandaloneRun();
    const probe = net.createServer();
    const explicitPort = await new Promise<number>((resolve) =>
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as net.AddressInfo).port)),
    );
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const second = await server.start({ embedded: false, port: explicitPort });

    expect(second.port).toBe(explicitPort);
    expect(fs.readFileSync(portFile(), 'utf-8')).toBe(String(first.port));
  });

  // 28. Only the saved port falls back: a taken explicit port fails the start
  //     instead of serving where nobody asked.
  it('fails the start on a taken explicit port', async () => {
    const blocker = net.createServer();
    const busyPort = await new Promise<number>((resolve) =>
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port)),
    );

    try {
      await expect(server.start({ embedded: false, port: busyPort })).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  // 29. Whatever the port file holds, the start succeeds and saves the port it
  //     picked; a port below 1024, where a bind can need privileges, is never tried.
  it.each([
    ['text', 'not a port'],
    ['a port below 1024', '80'],
    ['a port above 65535', '70000'],
  ])('starts over a server-port file holding %s', async (_case, contents) => {
    fs.writeFileSync(portFile(), contents);

    const config = await server.start({ embedded: false });

    expect(config.port).toBeGreaterThanOrEqual(1024);
    expect(fs.readFileSync(portFile(), 'utf-8')).toBe(String(config.port));
  });

  // 30. A live server keeps serving the token it started with, so a new one
  //     saved under it would revoke nothing.
  it('leaves a live standalone server and its token file alone on newToken', async () => {
    const live = await server.start({ embedded: false });

    const second = new PixelAgentsServer();
    try {
      const config = await second.start({ embedded: false, newToken: true });
      expect(config.token).toBe(live.token);
      expect(fs.readFileSync(tokenFile(), 'utf-8')).toBe(live.token);
    } finally {
      second.stop();
    }
  });
});

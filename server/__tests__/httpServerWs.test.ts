import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { WS_CLOSE_FORBIDDEN_ORIGIN, WS_CLOSE_UNAUTHORIZED } from '../src/constants.js';

// Isolated temp HOME: the server writes ~/.pixelmates/{server.json,servers/}
// and the consent assertions below read ~/.pixelmates/config.json.
let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { grantHooksConsent, recordHooksDecline } = await import('../src/configPersistence.js');

/** How long to wait, after the handshake, for a server-side rejection close.
 *  The gate runs synchronously in the route handler, so a rejection lands
 *  immediately; this is slack, not a real delay. */
const SETTLE_MS = 750;

interface ConnectResult {
  /** True when the connection survived the server's gate. */
  accepted: boolean;
  /** Close code, when the server closed us instead. */
  closeCode?: number;
  /** HTTP status, when the server refused the upgrade itself. */
  httpStatus?: number;
  socket: WebSocket;
}

/**
 * Open a /ws socket and report whether the server KEPT it. `@fastify/websocket`
 * completes the HTTP upgrade before the route handler runs, so a rejected
 * connection still fires 'open' and is then closed with an application close
 * code — "accepted" therefore means "still open after the settle window", not
 * "'open' fired". (The handler returns before registering its 'message'
 * listener, so a rejected socket can never have a message processed.)
 */
function connect(port: number, headers: Record<string, string> = {}): Promise<ConnectResult> {
  return connectTo(`ws://127.0.0.1:${port.toString()}/ws`, headers);
}

/**
 * Same as connect(), for a URL the caller builds — a `localhost` host, or one
 * carrying (or deliberately omitting) the `?token=` privilege query.
 */
function connectTo(url: string, headers: Record<string, string> = {}): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    let closeCode: number | undefined;
    const failTimer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out waiting for the /ws handshake to settle'));
    }, 5_000);
    const settle = (): void => {
      clearTimeout(failTimer);
      resolve({ accepted: closeCode === undefined, closeCode, socket });
    };
    socket.on('open', () => setTimeout(settle, SETTLE_MS));
    socket.on('close', (code: number) => {
      closeCode = code;
      settle();
    });
    socket.on('unexpected-response', (_req, res) => {
      clearTimeout(failTimer);
      res.resume();
      resolve({ accepted: false, httpStatus: res.statusCode, socket });
    });
    socket.on('error', () => {
      /* a server-side close surfaces as 'close'; ignore the paired error */
    });
  });
}

/** Wait for one JSON message of the given type (or resolve null on timeout). */
function waitForMessage(socket: WebSocket, type: string, ms = 2_000): Promise<unknown | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === type) {
          clearTimeout(timer);
          resolve(msg);
        }
      } catch {
        /* ignore non-JSON frames */
      }
    });
  });
}

function readHooksConsent(): boolean {
  try {
    const raw = fs.readFileSync(path.join(tmpBase, '.pixelmates', 'config.json'), 'utf-8');
    const consent = (JSON.parse(raw) as { hooksConsent?: Record<string, string> }).hooksConsent;
    return consent?.claude === 'granted';
  } catch {
    return false;
  }
}

describe('/ws connection gate', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  const sockets: WebSocket[] = [];

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ws-test-'));
    fs.mkdirSync(path.join(tmpBase, '.pixelmates'), { recursive: true });
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function startStandalone(): Promise<{ port: number; token: string }> {
    const config = await server.start({
      embedded: false,
      store: new AgentStateStore(),
      // Mirrors the standalone CLI's own side effect (server/src/cli.ts): an
      // enable toggle over this socket IS the consent grant. Wired here so the
      // cross-origin test asserts the real privilege, not just a close code.
      onSetHooksEnabled: async (providerId: string, enabled: boolean) => {
        if (enabled) grantHooksConsent(providerId);
      },
    });
    return { port: config.port, token: config.token };
  }

  // 1. THE finding: a WebSocket connect is not blocked by CORS, so a page the
  //    user happens to be visiting could open /ws and grant durable consent to
  //    modify ~/.claude/settings.json. A forged Origin must be refused, and no
  //    message it sends may take effect.
  it('rejects a cross-origin standalone connection and its setHooksEnabled', async () => {
    const { port } = await startStandalone();

    const result = await connect(port, { Origin: 'http://evil.example' });
    sockets.push(result.socket);

    expect(result.accepted).toBe(false);
    expect(result.closeCode).toBe(WS_CLOSE_FORBIDDEN_ORIGIN);

    // Even if the attacker keeps writing, nothing is processed.
    try {
      result.socket.send(
        JSON.stringify({ type: 'setHooksEnabled', providerId: 'claude', enabled: true }),
      );
    } catch {
      /* socket already closed — that IS the point */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readHooksConsent()).toBe(false);
  });

  // 2. The SPA loaded from the tokened URL the CLI printed: same origin plus the
  //    forwarded `?token=`. Connects normally.
  it('accepts a same-origin standalone connection carrying the token', async () => {
    const { port, token } = await startStandalone();

    const result = await connectTo(
      `ws://127.0.0.1:${port.toString()}/ws?token=${encodeURIComponent(token)}`,
      { Origin: `http://127.0.0.1:${port.toString()}` },
    );
    sockets.push(result.socket);

    expect(result.accepted).toBe(true);

    // And the channel actually works: webviewReady gets a handshake back.
    const settled = waitForMessage(result.socket, 'hooksStatus');
    result.socket.send(JSON.stringify({ type: 'webviewReady' }));
    expect(await settled).not.toBeNull();
  });

  // 3. Watching the office needs the token too: the broadcast stream carries
  //    tool activity. Every handshake that passes the Origin check but lacks
  //    the right token is closed before its first broadcast.
  it.each([
    ['no Origin (non-browser client)', '', {}],
    ['same origin, bare URL', '', { Origin: 'http://127.0.0.1:PORT' }],
    ['same origin, wrong token', '?token=not-the-token', { Origin: 'http://127.0.0.1:PORT' }],
    // A LAN-bound TCP forwarder piping to 127.0.0.1 with a forged loopback
    // Host: loopback peer, loopback Host, no token.
    ['loopback forwarder', '', { Host: 'localhost:PORT', Origin: 'http://localhost:PORT' }],
  ])('rejects a standalone connection without the token: %s', async (_name, query, headers) => {
    const { port } = await startStandalone();
    const withPort = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, v.replace('PORT', port.toString())]),
    );

    const result = await connectTo(`ws://127.0.0.1:${port.toString()}/ws${query}`, withPort);
    sockets.push(result.socket);

    expect(result.accepted).toBe(false);
    expect(result.closeCode).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  // 4. DNS rebinding: `evil.example` re-resolved to 127.0.0.1. The browser sends
  //    Origin AND Host as `evil.example:PORT`, so the Origin === Host check
  //    passes. The loopback Host allowlist refuses it before any route runs,
  //    even when the attacker somehow holds the token.
  it('refuses a rebound Host on every route, token or not', async () => {
    const { port, token } = await startStandalone();
    const forged = `evil.example:${port.toString()}`;

    const healthStatus = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: forged } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on('error', reject);
    });
    expect(healthStatus).toBe(403);

    const result = await connectTo(
      `ws://127.0.0.1:${port.toString()}/ws?token=${encodeURIComponent(token)}`,
      { Origin: `http://${forged}`, Host: forged },
    );
    sockets.push(result.socket);
    expect(result.httpStatus).toBe(403);
  });

  // The allowlist's own controls: loopback names pass on a loopback bind, an
  // absent Host does not, and a LAN bind skips the check (it relies on the
  // token, since its Host is whatever name the LAN uses).
  it.each([
    ['localhost', '127.0.0.1', 'localhost:PORT', true],
    ['IPv6 loopback', '127.0.0.1', '[::1]:PORT', true],
    ['LAN name on a LAN bind', '0.0.0.0', '192.168.1.5:PORT', true],
  ])('Host allowlist: %s', async (_name, bind, hostHeader, allowed) => {
    const config = await server.start({
      embedded: false,
      host: bind,
      store: new AgentStateStore(),
    });
    const port = config.port;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port,
            path: '/api/health',
            setHost: hostHeader !== null,
            headers:
              hostHeader === null ? {} : { Host: hostHeader.replace('PORT', port.toString()) },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        )
        .on('error', reject);
    });
    expect(status === 200).toBe(allowed);
  });

  // HTTP/1.1 without Host never reaches Fastify (Node answers 400), but
  // HTTP/1.0 may omit it and does. No Host is not a loopback name.
  it('refuses an HTTP/1.0 request with no Host header', async () => {
    const { port } = await startStandalone();
    const head = await new Promise<string>((resolve, reject) => {
      const conn = net.connect(port, '127.0.0.1', () => {
        conn.write('GET /api/health HTTP/1.0\r\n\r\n');
      });
      let data = '';
      conn.on('data', (chunk) => (data += chunk.toString()));
      conn.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
      conn.on('error', reject);
    });
    expect(head).toMatch(/^HTTP\/1\.[01] 403 /);
  });

  // 5. An unparseable Origin is not a same-origin browser request.
  it('rejects a standalone connection with a malformed Origin', async () => {
    const { port } = await startStandalone();

    const result = await connect(port, { Origin: 'not a url' });
    sockets.push(result.socket);

    expect(result.accepted).toBe(false);
    expect(result.closeCode).toBe(WS_CLOSE_FORBIDDEN_ORIGIN);
  });

  // 6. Embedded mode is Bearer-gated and unchanged by the Origin gate: a
  //    same-origin-looking connection without the token is still refused.
  it('rejects an embedded connection without the Bearer token', async () => {
    const config = await server.start({ embedded: true, store: new AgentStateStore() });

    const result = await connect(config.port, {
      Origin: `http://127.0.0.1:${config.port.toString()}`,
    });
    sockets.push(result.socket);

    expect(result.accepted).toBe(false);
    expect(result.closeCode).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  // 7. Embedded + correct token connects, and no Origin gate is applied there
  //    (the VS Code webview's Origin is a vscode-webview:// URL, never our host).
  it('accepts an embedded connection with the Bearer token and a foreign Origin', async () => {
    const config = await server.start({ embedded: true, store: new AgentStateStore() });

    const result = await connect(config.port, {
      Authorization: `Bearer ${config.token}`,
      Origin: 'vscode-webview://some-webview-id',
    });
    sockets.push(result.socket);

    expect(result.accepted).toBe(true);
  });
});

/**
 * What a tokened socket may DO: grant `grantHooksConsent()`, durable,
 * machine-wide approval to modify ~/.claude/settings.json plus a 12-event hook
 * install. Tokenless handshakes never get this far (see the connection gate),
 * so these tests pin that the legitimate routes still work end to end.
 */
describe('/ws privileged-message gate', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  const sockets: WebSocket[] = [];
  /** Values `onSetHooksEnabled` was invoked with — the install/uninstall seam. */
  let sideEffects: boolean[];

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ws-priv-'));
    fs.mkdirSync(path.join(tmpBase, '.pixelmates'), { recursive: true });
    sideEffects = [];
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function startStandalone(): Promise<{ port: number; token: string }> {
    const config = await server.start({
      embedded: false,
      store: new AgentStateStore(),
      // The real cli.ts side effect, minus the actual install: an enable
      // toggle over this socket IS the consent grant (server/src/cli.ts).
      onSetHooksEnabled: (providerId: string, enabled: boolean) => {
        sideEffects.push(enabled);
        if (enabled) grantHooksConsent(providerId);
      },
    });
    return { port: config.port, token: config.token };
  }

  /** Send setHooksEnabled over an accepted socket and let it settle. */
  async function sendToggle(socket: WebSocket, enabled: boolean): Promise<void> {
    socket.send(JSON.stringify({ type: 'setHooksEnabled', providerId: 'claude', enabled }));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // The route this gate exists to keep working: the real local SPA, loaded from
  // the tokened URL the CLI printed, forwarding that token on the handshake
  // (webview-ui/src/transport/index.ts). The toggle installs, exactly as
  // documented ("enable hooks in the UI settings").
  it('allows setHooksEnabled from the local SPA', async () => {
    // An answered ask, so the toggle installs instead of asking first (consentFlow.test.ts).
    recordHooksDecline('claude');
    const { port, token } = await startStandalone();

    const result = await connectTo(
      `ws://127.0.0.1:${port.toString()}/ws?token=${encodeURIComponent(token)}`,
      { Origin: `http://127.0.0.1:${port.toString()}` },
    );
    sockets.push(result.socket);

    await sendToggle(result.socket, true);
    expect(sideEffects).toEqual([true]);
    expect(readHooksConsent()).toBe(true);
  });

  // ...and over `localhost`, which resolves to ::1 as often as 127.0.0.1.
  it('allows setHooksEnabled over a localhost URL', async () => {
    recordHooksDecline('claude');
    const { port, token } = await startStandalone();

    const result = await connectTo(
      `ws://localhost:${port.toString()}/ws?token=${encodeURIComponent(token)}`,
      { Origin: `http://localhost:${port.toString()}` },
    );
    sockets.push(result.socket);

    await sendToggle(result.socket, true);
    expect(sideEffects).toEqual([true]);
    expect(readHooksConsent()).toBe(true);
  });

  // ── The in-app consent dialog rides the same privilege boundary ──

  // The first-run ask is solicited by the server during the webviewReady
  // handshake, and only where the answer could be honored: a tokened client.
  it('sends hooksConsentRequest on the tokened handshake', async () => {
    const { port, token } = await startStandalone();

    const result = await connectTo(
      `ws://127.0.0.1:${port.toString()}/ws?token=${encodeURIComponent(token)}`,
      { Origin: `http://127.0.0.1:${port.toString()}` },
    );
    sockets.push(result.socket);

    const request = waitForMessage(result.socket, 'hooksConsentRequest');
    result.socket.send(JSON.stringify({ type: 'webviewReady' }));
    expect(await request).toMatchObject({ type: 'hooksConsentRequest' });
  });

  // The route the dialog exists for: the tokened SPA's Install button grants
  // consent and runs the install, end to end over the real wire.
  it('accepts the tokened dialog approval: install runs and consent is granted', async () => {
    const { port, token } = await startStandalone();

    const result = await connectTo(
      `ws://127.0.0.1:${port.toString()}/ws?token=${encodeURIComponent(token)}`,
      { Origin: `http://127.0.0.1:${port.toString()}` },
    );
    sockets.push(result.socket);

    result.socket.send(
      JSON.stringify({ type: 'hooksConsentResponse', providerId: 'claude', choice: 'install' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sideEffects).toEqual([true]);
    expect(readHooksConsent()).toBe(true);
  });
});

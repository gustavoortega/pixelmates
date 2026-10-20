import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import * as crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import { agentStatusMessage } from './agentActivityResend.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import {
  HOOK_API_PREFIX,
  MAX_HOOK_BODY_SIZE,
  STATUSLINE_API_PREFIX,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
} from './constants.js';
import type { TokenLedger } from './tokenLedger.js';
import type { AgentState } from './types.js';
import { parseUsageLimitsBody } from './usage/usageLimitsBody.js';
import type { UsageLimitsStore } from './usage/usageLimitsStore.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /** Token ledger whose snapshot is sent on connect and which budget changes refresh. Standalone only. */
  tokenLedger?: TokenLedger;
  /** Receives the official limits the status line wrapper posts; its latest reading is sent on connect. */
  usageLimits?: UsageLimitsStore;
  /** Destination of the standalone request log, stdout when unset. Ignored when embedded, which logs nothing. */
  logStream?: NodeJS.WritableStream;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/**
 * Sent on every reply. The SPA loads only its own bundle, stylesheet, fonts and
 * images, and dials its socket back to the host that served it (CSP3 'self'
 * matches ws: and wss: on that host and port), so injected markup can neither
 * run nor reach anywhere else, and nothing may frame the office, post a form
 * out of it or rebase its urls. no-referrer keeps the `?token=` in the page url
 * out of every Referer; nosniff stops the index.html fallback, served at any
 * unknown script url, from running as a script.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    logger: options.embedded
      ? false
      : {
          serializers: {
            req: redactedRequestSerializer,
            // @fastify/websocket logs the raw url under `path` when it closes an
            // upgrade on a route with no ws handler (`/`, `/ws/`, `/api/health`).
            path: (value: unknown) => (typeof value === 'string' ? redactTokenParam(value) : value),
          },
          redact: {
            paths: ['req.headers.authorization', 'headers.authorization'],
            censor: '[redacted]',
          },
          ...(options.logStream ? { stream: options.logStream } : {}),
        },
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  // Root level and unconditional: a LAN bind serves the same SPA, embedded
  // answers on the same machine, and the rebinding 403 and the index.html
  // fallback are pages too.
  app.addHook('onSend', async (_request, reply) => {
    reply.headers(SECURITY_HEADERS);
  });

  const host = options.host ?? '127.0.0.1';
  // DNS rebinding: a page on evil.com resolved to 127.0.0.1 reaches us with
  // `Host: evil.com:PORT`. On a loopback bind the only legitimate Host values
  // are loopback names, so refuse the rest before any route (static, health,
  // /ws) answers. A LAN bind (--host 0.0.0.0) is reachable under names we
  // cannot enumerate, so it relies on the /ws token alone. Hostname-based
  // forwarders (Codespaces, tunnels) land here too, hence the hint.
  if (isLoopbackHost(host)) {
    app.addHook('onRequest', async (request, reply) => {
      if (!isLoopbackHost(hostnameOf(request.headers.host))) {
        const address = app.server.address();
        const port = typeof address === 'object' ? (address?.port ?? 0) : 0;
        reply
          .code(403)
          .send(
            `Forbidden Host. Open http://127.0.0.1:${port.toString()}/ or start with --host 0.0.0.0.`,
          );
      }
    });
  }

  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  const staticDir = options.embedded ? undefined : options.staticDir;
  if (staticDir) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
    });
  }
  // Always our own handler: Fastify's default one logs `Route GET:<url> not
  // found` at info level, `?token=` included, past the req serializer. The SPA
  // gets the HTML5 history fallback.
  app.setNotFoundHandler((_req, reply) => {
    if (staticDir) {
      reply.sendFile('index.html');
    } else {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });
    }
  });

  // ── Routes ──────────────────────────────────────────────────

  registerHealthRoute(app);
  registerHookRoute(app, options);
  registerStatuslineRoute(app, options);
  registerWebSocketRoute(app, options);

  // ── Listen ──────────────────────────────────────────────────

  try {
    await app.listen({ host, port: options.port ?? 0 });
  } catch (err) {
    // The caller never receives this instance, so only we can release it before
    // the caller decides whether to retry on another port.
    await app.close();
    throw err;
  }
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      // onRequest runs before Fastify reads the body: under --host 0.0.0.0 a
      // client without the token must not get a 1 MiB body buffered and parsed.
      onRequest: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── Official usage limits ─────────────────────────────────────

/** Same provider-id shape the hook route's params schema enforces. */
const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * The status line wrapper's ingress. Same bearer token as the hooks and, like
 * them, no registry lookup on the provider id. No Fastify `schema` on purpose:
 * the default AJV strips unknown keys and coerces types, which would turn a
 * wrapper that forwarded the whole status line input into a quiet 200
 * (usageLimitsBody.ts explains). Validated by hand instead: 400 for anything
 * but the two windows.
 */
function registerStatuslineRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{ Params: { providerId: string } }>(
    `${STATUSLINE_API_PREFIX}/:providerId`,
    // Before the body is read, as on the hook route: the body limit is 1 MiB here too.
    { onRequest: bearerAuth(options.token) },
    async (request, reply) => {
      if (!PROVIDER_ID_PATTERN.test(request.params.providerId)) {
        reply.code(400).send('invalid provider id');
        return;
      }
      const body = parseUsageLimitsBody(request.body);
      if (body === null) {
        reply.code(400).send('invalid usage limits');
        return;
      }
      options.usageLimits?.set(body, Date.now());
      reply.send('ok');
    },
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // CONNECTION gate. Both modes require the out-of-band token: embedded as the
    // Bearer header it was handed in-process, standalone as the `?token=` the
    // CLI printed in the local URL and the SPA forwards on this handshake. The
    // broadcast stream carries tool activity and folder names, so watching the
    // office is as sensitive as acting on it. Origin is checked first only to
    // give cross-origin pages a distinct close code.
    if (options.embedded) {
      if (!timingSafeStringEqual(request.headers.authorization ?? '', `Bearer ${options.token}`)) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
    } else if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
      return;
    } else if (!standaloneTokenValid(request.url, options.token)) {
      socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }

    const { store } = options;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, {
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
      });
      // The client starts external agents idle; say what they really are, read from
      // the state at send time so a status derived from the transcript is not lost.
      if (agent.isExternal) safeSend(socket, agentStatusMessage(id, agent));
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[pixelmates] WS client message:', msg.type);
        }
        handleClientMessage(msg, (m) => safeSend(socket, m), {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
          tokenLedger: options.tokenLedger,
          usageLimits: options.usageLimits,
          // Every accepted socket proved the token above.
          privileged: true,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

/**
 * Standalone `/ws` CONNECTION gate: is this handshake same-origin?
 *
 * WebSocket connects are NOT subject to CORS, so without this any web page the
 * user happens to visit could open a socket to 127.0.0.1 and start talking.
 * Comparing Origin's host against the request's own Host header makes the check
 * same-origin by construction — it tracks whatever --host/--port the server was
 * bound to with zero configuration, and treats `localhost` and `127.0.0.1`
 * correctly (a browser derives both headers from the URL that loaded the SPA).
 *
 * A missing Origin passes here (non-browser clients send none); the token check
 * after it still applies.
 *
 * This gate is NOT sufficient on its own. Both header values are
 * attacker-supplied, so a DNS-rebound page (`evil.com` → 127.0.0.1) sends
 * `Origin: http://evil.com:PORT` AND `Host: evil.com:PORT` and passes equality.
 * The loopback Host hook and standaloneTokenValid are what stop it.
 */
export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined || origin === '') return true;
  try {
    return new URL(origin).host === host;
  } catch {
    // An unparseable Origin is not a same-origin browser request.
    return false;
  }
}

/**
 * Whether a standalone handshake carries the server token. Required to
 * connect at all: the socket both streams agent activity and accepts
 * `setHooksEnabled`, which grants durable, machine-wide consent to modify
 * `~/.claude/settings.json` and installs (or removes) a 12-event hook set.
 *
 * The handshake must carry the server token in its `?token=` query. That token
 * is minted at startup (server.ts), printed by the CLI inside the LOCAL url it
 * emits to the operator's terminal, and forwarded by the SPA loaded from that
 * url (webview-ui/src/transport/index.ts). It is the Jupyter model.
 *
 * Why a secret rather than a network position: EVERY position is reproducible.
 * The predecessor of this function required a loopback peer address AND a
 * loopback `Host`, on the theory that only a real local browser satisfies both.
 * A dumb TCP forwarder bound to the LAN, piping bytes verbatim to 127.0.0.1,
 * presents the server exactly what the SPA presents — `remoteAddress` is
 * 127.0.0.1 because the forwarder terminated the hop there, and `Host` is
 * whatever the remote client typed. Reproduced against the real `dist/cli.js`:
 * a client on another machine acquired consent and a 12-event install. Peer
 * address and Host/Origin are all carried BY the channel a proxy speaks, so the
 * gate must ride something the channel never carries — an out-of-band secret
 * the operator's own URL delivers and the forwarded attacker never sees.
 */
function standaloneTokenValid(url: string | undefined, expected: string): boolean {
  // Defensive: an empty configured token would otherwise privilege every
  // handshake that omits the query (both sides compare equal as '').
  if (!expected) return false;
  let provided: string;
  try {
    // Parsed against a dummy base because `request.url` is path-relative. Read
    // from the raw url rather than a framework-parsed query so the gate does
    // not depend on @fastify/websocket populating one on the upgrade request.
    provided = new URL(url ?? '', 'http://localhost').searchParams.get('token') ?? '';
  } catch {
    return false;
  }
  return timingSafeStringEqual(provided, expected);
}

// ── Auth Helper ────────────────────────────────────────────────

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/** Hostname part of a `Host` header, without the port. */
function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return '';
  }
}

/** Constant-time string compare, length-guarded (timingSafeEqual throws on a
 *  length mismatch). One implementation for all three token comparisons. */
function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  return actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!timingSafeStringEqual(request.headers.authorization ?? '', `Bearer ${expectedToken}`)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Utilities ──────────────────────────────────────────────────

/**
 * A url with its `token` query value replaced. The standalone token rides the
 * printed SPA url and the `/ws` handshake, and it is a replayable bearer
 * capability: a pasted log or a shared scrollback must not carry it.
 */
export function redactTokenParam(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
}

/** The request fields Fastify logs by default, with the url's token redacted. */
export function redactedRequestSerializer(request: FastifyRequest): {
  method: string;
  url: string;
  host: string;
  remoteAddress: string;
  remotePort: number | undefined;
} {
  return {
    method: request.method,
    url: redactTokenParam(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

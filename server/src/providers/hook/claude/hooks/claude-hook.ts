import * as http from 'http';
import * as os from 'os';

import { HOOK_API_PREFIX } from '../../../../constants.js';
import type { ServerTarget } from '../../../../serverConfig.js';
import { readServerTargets } from '../serverTargets.js';
import { createScriptDebugLog } from './scriptDebugLog.js';

/** Opt-in PIXELMATES_DEBUG_LOG file logger (see scriptDebugLog.ts). */
const debug = createScriptDebugLog('HOOKSCRIPT');
function hookDebug(line: string): void {
  debug.log(line);
}

/**
 * POST one hook event to one server. Best-effort: every failure path (bad
 * connection, timeout, non-2xx status) resolves quietly -- a dropped delivery
 * to one server must never affect delivery to any other server, nor the
 * script's exit code.
 */
function postToServer(
  server: ServerTarget,
  body: string,
  eventName: string,
  sid: string,
): Promise<void> {
  hookDebug(`POST event=${eventName} sid=${sid} port=${server.port}`);
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: `${HOOK_API_PREFIX}/claude`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: 2000,
        },
        (res) => {
          hookDebug(
            `POST-done event=${eventName} sid=${sid} status=${res.statusCode} port=${server.port}`,
          );
          res.resume();
          resolve();
        },
      );
      req.on('error', (err) => {
        hookDebug(
          `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err.message}`,
        );
        resolve();
      });
      req.on('timeout', () => {
        hookDebug(`POST-timeout event=${eventName} sid=${sid} port=${server.port}`);
        req.destroy();
        resolve();
      });
      req.end(body);
    } catch (err) {
      hookDebug(
        `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err instanceof Error ? err.message : String(err)}`,
      );
      resolve();
    }
  });
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    hookDebug('exit reason=bad-stdin');
    process.exit(0);
  }

  const eventName = (data.hook_event_name as string | undefined) ?? '?';
  const sid = (data.session_id as string | undefined)?.slice(0, 8) ?? '?';

  // Multi-server fan-out (D4): every live registry entry, else the legacy
  // server.json (serverTargets.ts owns the rules; the status line wrapper uses
  // the same ones).
  const servers: ServerTarget[] = readServerTargets(os.homedir(), hookDebug);
  if (servers.length === 0) {
    hookDebug(`exit reason=no-server-json event=${eventName} sid=${sid}`);
    process.exit(0);
  }

  debug.adoptFrom(servers);

  const body = JSON.stringify(data);
  await Promise.all(servers.map((server) => postToServer(server, body, eventName, sid)));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));

import * as os from 'os';
import * as readline from 'readline';

import { LOG_PREFIX, ORPHAN_CHECK_INTERVAL_MS, RPC_INTERNAL_ERROR } from './constants.js';
import { createDispatcher } from './rpc.js';
import { resolveProjectDir, resolveProjectPath } from './scope.js';

/**
 * Entry of the memory MCP stdio server (bundled to plugin/server/memory-mcp.cjs). stdout carries protocol
 * lines only; every log line goes to stderr and carries metadata only, never arguments, paths or transcript
 * text.
 */

// Nothing but protocol may reach stdout.
console.log = (): void => undefined;
console.info = (): void => undefined;
console.debug = (): void => undefined;

const VERSION = process.env.PIXELMATES_VERSION ?? '0.0.0';

function log(line: string): void {
  try {
    process.stderr.write(`${LOG_PREFIX} ${line}\n`);
  } catch {
    /* stderr gone: nothing to do */
  }
}

/** Never error.message: it can quote transcript text (a SyntaxError quotes its input). */
function fatal(err: unknown): never {
  log(`fatal ${err instanceof Error ? err.name : 'unknown'}`);
  process.exit(1);
}

function write(line: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${line}\n`, () => resolve());
  });
}

/** Exit once everything written so far has been flushed (pipes are asynchronous on macOS). */
function exitAfterFlush(code: number): void {
  process.stdout.write('', () => process.exit(code));
}

function main(): void {
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.stdout.on('error', () => process.exit(0));
  setInterval(() => {
    if (process.ppid === 1) process.exit(0);
  }, ORPHAN_CHECK_INTERVAL_MS).unref();

  const home = os.homedir();
  const projectPath = resolveProjectPath(process.env, process.cwd());
  log(`started project_dir_found=${resolveProjectDir(home, projectPath) !== null}`);
  const dispatch = createDispatcher(
    { home, projectPath, tmpdir: os.tmpdir(), now: Date.now, log },
    VERSION,
  );

  // Requests are answered in arrival order; on end of input the queue drains, then the process exits.
  let queue: Promise<void> = Promise.resolve();
  process.stdin.setEncoding('utf8');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    queue = queue.then(async () => {
      let response: string | null;
      try {
        response = await dispatch(line);
      } catch (err) {
        log(`error ${err instanceof Error ? err.name : 'unknown'}`);
        response = internalError(line);
      }
      if (response !== null) await write(response);
    });
  });
  lines.on('close', () => {
    void queue.then(() => exitAfterFlush(0));
  });
}

/** -32603 for a request whose handler threw; a notification still gets nothing. */
function internalError(line: string): string | null {
  try {
    const msg = JSON.parse(line) as { id?: unknown };
    if (typeof msg.id !== 'string' && typeof msg.id !== 'number') return null;
    return JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: RPC_INTERNAL_ERROR, message: 'Internal error' },
    });
  } catch {
    return null;
  }
}

main();

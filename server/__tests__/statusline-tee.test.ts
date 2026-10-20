import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeStatuslineCommand } from '../src/providers/hook/claude/commandIdentity.js';

const TEE = path.join(__dirname, '../../dist/hooks/statusline-tee.js');

/** What Claude Code pipes to a status line: the two limit windows among fields that must never leave the machine. */
const STATUS_INPUT = {
  session_id: 'sess-0001',
  transcript_path: '/home/someone/.claude/projects/-home-someone-private/sess-0001.jsonl',
  cwd: '/home/someone/private-repo',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  cost: { total_cost_usd: 1.23 },
  rate_limits: {
    five_hour: { used_percentage: 37.5, resets_at: 1_760_000_000 },
    seven_day: { used_percentage: 12, resets_at: 1_760_400_000 },
  },
};

/** An original that prints PAYLOAD_HEX's bytes and exits with EXIT_CODE. Both come from the environment, which also
 *  proves the original runs with the tee's own. */
const PRINT_PAYLOAD = `node -e "process.stdout.write(Buffer.from(process.env.PAYLOAD_HEX, 'hex')); process.exitCode = Number(process.env.EXIT_CODE)"`;

/** ANSI colors, an OSC 8 hyperlink and a non-ASCII arrow, as a real status line prints them. */
const STATUS_BYTES = Buffer.from(
  '\u001b[31m5h 38%\u001b[0m ↗120% \u001b]8;;https://example.com/pr/1\u0007PR #1\u001b]8;;\u0007\n',
  'utf8',
);

let home: string;

interface Recorded {
  url: string;
  authorization: string;
  body: string;
  /** Epoch ms when the whole body had arrived. */
  at: number;
}

function startRecordingServer(
  respond = true,
): Promise<{ port: number; received: Recorded[]; close: () => void }> {
  const received: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        authorization: req.headers.authorization ?? '',
        body,
        at: Date.now(),
      });
      if (respond) {
        res.writeHead(200);
        res.end('ok');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        received,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/** A port nothing listens on: bound once, then released. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** One live registry entry (~/.pixelmates/servers/<pid>-<port>.json), the way a running server announces itself. */
function registerServer(port: number, token: string): void {
  const dir = path.join(home, '.pixelmates', 'servers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${process.pid}-${port}.json`),
    JSON.stringify({
      port,
      pid: process.pid,
      token,
      startedAt: Date.now(),
      servesSpa: false,
      protocol: 1,
    }),
  );
}

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** Epoch ms when the process closed. */
  closedAt: number;
}

function run(
  command: string,
  args: string[],
  stdin: string | Buffer,
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 8000,
    });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      const closedAt = Date.now();
      resolve({ code, stdout: Buffer.concat(out), stderr, closedAt });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

function runTee(
  args: string[],
  stdin: string | Buffer,
  env: Record<string, string> = {},
): Promise<RunResult> {
  return run('node', [TEE, ...args], stdin, env);
}

const payloadEnv = (exitCode: number): Record<string, string> => ({
  PAYLOAD_HEX: STATUS_BYTES.toString('hex'),
  EXIT_CODE: String(exitCode),
});

describe('statusline-tee.js', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-tee-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** These spawn the BUNDLED wrapper, so they need `npm run build` first: a loud skip rather than a false green. The
   *  wrapper runs the original through `sh`, which is POSIX only, like the install. */
  const itBuilt = it.skipIf(!fs.existsSync(TEE) || process.platform === 'win32');

  // C1: the body is built from two fields, so nothing else in the status line input can leave.
  itBuilt('posts only the two limit windows, with the bearer token', async () => {
    const server = await startRecordingServer();
    registerServer(server.port, 'tok-1');

    const { code } = await runTee(['cat > /dev/null'], JSON.stringify(STATUS_INPUT));

    server.close();
    expect(code).toBe(0);
    expect(server.received).toHaveLength(1);
    expect(server.received[0].url).toBe('/api/statusline/claude-statusline');
    expect(server.received[0].authorization).toBe('Bearer tok-1');
    expect(JSON.parse(server.received[0].body)).toEqual({
      fiveHour: { usedPercentage: 37.5, resetsAt: 1_760_000_000 },
      sevenDay: { usedPercentage: 12, resetsAt: 1_760_400_000 },
    });
  });

  // C1: the user's status line reaches Claude Code untouched, colors and links included, and so does its exit code.
  itBuilt('passes the original output through byte for byte and exits with its code', async () => {
    const server = await startRecordingServer();
    registerServer(server.port, 'tok-1');

    const { code, stdout, stderr } = await runTee(
      [PRINT_PAYLOAD],
      JSON.stringify(STATUS_INPUT),
      payloadEnv(3),
    );

    server.close();
    expect(stdout.equals(STATUS_BYTES)).toBe(true);
    expect(stderr).toBe('');
    expect(code).toBe(3);
  });

  // C2: a server that never answers costs the status line at most the POST budget. Timed from the POST's arrival, so
  // the two process startups a loaded machine slows down are not part of the measure.
  itBuilt(
    'prints the status line and exits within 1 s of a POST the server never answers',
    async () => {
      const server = await startRecordingServer(false);
      registerServer(server.port, 'tok-1');

      const { code, stdout, closedAt } = await runTee(
        ["echo '5h 38%'"],
        JSON.stringify(STATUS_INPUT),
      );

      server.close();
      expect(stdout.toString()).toBe('5h 38%\n');
      expect(code).toBe(0);
      expect(server.received).toHaveLength(1);
      expect(closedAt - server.received[0].at).toBeLessThan(1000);
    },
  );

  // C2: the original starts at once and reads stdin as it arrives, so a status line never waits for the whole input
  // or for a POST.
  itBuilt('hands stdin to the original as it arrives, while stdin is still open', async () => {
    const child = spawn('node', [TEE, 'cat'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    const firstChunk = '{"rate_limits":';
    child.stdin.write(firstChunk);

    // What the original printed within 3 s, with stdin still open.
    const echoed = await new Promise<string>((resolve) => {
      let out = '';
      const timer = setTimeout(() => resolve(out), 3000);
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.length >= firstChunk.length) {
          clearTimeout(timer);
          resolve(out);
        }
      });
    });
    child.stdin.end('{}}');

    expect(echoed).toBe(firstChunk);
    expect(await closed).toBe(0);
  });

  // An unhandled request error would kill the wrapper with a stack trace on stderr and the wrong exit code, before
  // Claude Code reads the line.
  itBuilt(
    'is silent and keeps the exit code when a registered server refuses the connection',
    async () => {
      registerServer(await closedPort(), 'tok-1');

      const { code, stdout, stderr } = await runTee(
        [PRINT_PAYLOAD],
        JSON.stringify(STATUS_INPUT),
        payloadEnv(4),
      );

      expect(stdout.equals(STATUS_BYTES)).toBe(true);
      expect(stderr).toBe('');
      expect(code).toBe(4);
    },
  );

  // A shell reports an original killed by a signal as 128 + its number; Claude Code gets the same from the wrapper.
  itBuilt('exits 128 + the signal when the original is killed by one', async () => {
    const { code, stderr } = await runTee(['kill -TERM $$'], JSON.stringify(STATUS_INPUT));

    expect(code).toBe(143);
    expect(stderr).toBe('');
  });

  itBuilt('is silent and keeps the exit code when no server is registered at all', async () => {
    const { code, stdout, stderr } = await runTee(
      [PRINT_PAYLOAD],
      JSON.stringify(STATUS_INPUT),
      payloadEnv(5),
    );

    expect(stdout.equals(STATUS_BYTES)).toBe(true);
    expect(stderr).toBe('');
    expect(code).toBe(5);
  });

  // Installed over a missing statusLine, the wrapper has no original: it still reports, and shows nothing.
  itBuilt('with no original command prints nothing, still posts, and exits 0', async () => {
    const server = await startRecordingServer();
    registerServer(server.port, 'tok-1');

    const { code, stdout } = await runTee([], JSON.stringify(STATUS_INPUT));

    server.close();
    expect(stdout.length).toBe(0);
    expect(code).toBe(0);
    expect(server.received).toHaveLength(1);
  });

  // Past the cap the input is not parsed, but the original still gets every byte.
  itBuilt('forwards stdin past 256 KiB untouched and posts nothing', async () => {
    const server = await startRecordingServer();
    registerServer(server.port, 'tok-1');
    const big = Buffer.from(JSON.stringify({ ...STATUS_INPUT, pad: 'x'.repeat(300 * 1024) }));
    const hashStdin = `node -e "const h = require('crypto').createHash('sha256'); process.stdin.on('data', (d) => h.update(d)).on('end', () => process.stdout.write(h.digest('hex')))"`;

    const { code, stdout } = await runTee([hashStdin], big);
    await new Promise((resolve) => setTimeout(resolve, 100));

    server.close();
    expect(code).toBe(0);
    expect(stdout.toString()).toBe(createHash('sha256').update(big).digest('hex'));
    expect(server.received).toHaveLength(0);
  });

  // The chained command is what Claude Code runs: an original holding a single quote must survive the sh quoting.
  itBuilt(
    'runs an original containing a single quote exactly as sh would run it alone',
    async () => {
      const original = `printf '%s|%s\\n' "it's" 'a "quoted" $HOME \\ path'`;
      const direct = await run('sh', ['-c', original], '{}');

      const chained = await run('sh', ['-c', makeStatuslineCommand(TEE, original)], '{}');

      expect(direct.stdout.toString()).toBe(`it's|a "quoted" $HOME \\ path\n`);
      expect(chained.stdout.equals(direct.stdout)).toBe(true);
      expect(chained.code).toBe(direct.code);
    },
  );
});

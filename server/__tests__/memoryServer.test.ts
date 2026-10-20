import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NO_TRANSCRIPTS_TEXT } from '../src/memory/constants.js';
import {
  env,
  HOUR,
  type MemoryHome,
  memoryHome,
  PROJECT,
  prompt,
  said,
} from './helpers/memoryFixtures.js';

/**
 * The shipped bundle (plugin/server/memory-mcp.cjs, committed and kept current by the CI drift check), spawned
 * the way Claude Code starts it: protocol on stdin/stdout, logs on stderr.
 */

const BUNDLE = path.join(__dirname, '../../plugin/server/memory-mcp.cjs');

let h: MemoryHome;
beforeEach(() => {
  h = memoryHome();
});
afterEach(() => {
  h.cleanup();
});

interface Run {
  responses: Array<Record<string, unknown>>;
  stderr: string;
  code: number | null;
}

/** Write `lines` to a fresh server, close stdin, and collect everything it answers. */
function runServer(lines: string[], projectPath = PROJECT): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: h.home,
    CLAUDE_PROJECT_DIR: projectPath,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE], { cwd: h.home, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      const responses = stdout
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      resolve({ responses, stderr, code });
    });
    child.stdin.end(lines.map((l) => `${l}\n`).join(''));
  });
}

const rpc = (id: unknown, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const notify = (method: string): string => JSON.stringify({ jsonrpc: '2.0', method });

function seedSession(prefixText: string, endedText: string): void {
  const e = env(1);
  h.writeSession(h.projectDir(), e, [
    prompt(e, h.now - HOUR, `${prefixText} deploy the api`),
    said(e, h.now - HOUR + 1000, endedText),
  ]);
}

describe('memory MCP server over stdio', () => {
  it('[C1] answers initialize, tools/list and a recent_work call in order, echoing each id', async () => {
    seedSession('ship it:', 'Shipped.');
    const run = await runServer([
      rpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't' },
      }),
      notify('notifications/initialized'),
      rpc('two', 'tools/list'),
      rpc(0, 'tools/call', { name: 'recent_work', arguments: {} }),
    ]);

    expect(run.code).toBe(0);
    expect(run.responses.map((r) => r['id'])).toEqual([1, 'two', 0]);
    const init = run.responses[0]['result'] as Record<string, unknown>;
    expect(init['protocolVersion']).toBe('2025-06-18');
    expect(init['serverInfo']).toMatchObject({ name: 'pixelmates-memory' });
    const tools = (run.responses[1]['result'] as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'active_now',
      'find_past_work',
      'recent_work',
      'recent_work_all_projects',
    ]);
    const call = run.responses[2]['result'] as { content: Array<{ type: string; text: string }> };
    expect(call.content).toHaveLength(1);
    const [preamble, body] = call.content[0].text.split('\n');
    expect(preamble).toMatch(/^Records from past Claude Code sessions/);
    expect(JSON.parse(body).sessions[0].asked).toBe('ship it: deploy the api');
    expect(call).not.toHaveProperty('isError');
  });

  it('[C3] only recent_work_all_projects asks on every call, through top-level _meta', async () => {
    const run = await runServer([rpc(1, 'tools/list')]);
    const tools = (run.responses[0]['result'] as { tools: Array<Record<string, unknown>> }).tools;
    for (const tool of tools) {
      const expected =
        tool['name'] === 'recent_work_all_projects'
          ? { 'anthropic/requiresUserInteraction': true }
          : undefined;
      expect(tool['_meta'], String(tool['name'])).toEqual(expected);
      expect(JSON.stringify(tool['annotations'])).not.toContain('requiresUserInteraction');
      expect(JSON.stringify(tool['inputSchema'])).not.toContain('requiresUserInteraction');
    }
  });

  it('[C18] notifications are never answered, whatever their method', async () => {
    const run = await runServer([
      rpc(1, 'initialize', { protocolVersion: '2024-11-05' }),
      notify('notifications/initialized'),
      notify('notifications/cancelled'),
      notify('notifications/some_future_thing'),
      rpc(2, 'ping'),
    ]);
    expect(run.responses).toEqual([
      expect.objectContaining({ id: 1 }),
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });

  it('answers malformed input with the JSON-RPC error codes and bad arguments with a retryable isError', async () => {
    const run = await runServer([
      '{not json',
      '[1,2]',
      JSON.stringify({ id: 7, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }),
      '',
      rpc(0, 'no/such_method'),
      rpc(3, 'tools/call', { name: 'no_such_tool', arguments: {} }),
      rpc(4, 'tools/call', { name: 'recent_work', arguments: { since: 'last tuesday' } }),
      rpc(5, 'tools/call', { name: 'find_past_work', arguments: { query: ' ' } }),
      rpc(6, 'tools/call', { name: 'active_now', arguments: { verbose: true } }),
    ]);
    const errors = run.responses
      .slice(0, 6)
      .map((r) => [r['id'], (r['error'] as { code: number }).code]);
    expect(errors).toEqual([
      [null, -32700],
      [null, -32600],
      [7, -32600],
      [null, -32600],
      [0, -32601],
      [3, -32602],
    ]);
    for (const r of run.responses.slice(6)) {
      const res = r['result'] as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/accepts|takes no arguments/);
    }
    expect(run.responses).toHaveLength(9);
  });

  it('[C15] stderr carries metadata only: no argument, path or result text', async () => {
    seedSession('RESULT-CANARY-15', 'ENDED-CANARY-15');
    const run = await runServer([
      rpc(1, 'tools/call', { name: 'recent_work', arguments: { since: '7d' } }),
      rpc(2, 'tools/call', {
        name: 'find_past_work',
        arguments: { query: 'deploy RESULT-CANARY-15' },
      }),
      rpc(3, 'tools/call', { name: 'find_past_work', arguments: { query: 'ARG-CANARY-15' } }),
      rpc(4, 'tools/call', { name: 'recent_work', arguments: { since: 'SINCE-CANARY-15' } }),
      rpc(5, 'tools/call', {
        name: 'recent_work_all_projects',
        arguments: { under: '/Users/dev/UNDER-CANARY-15' },
      }),
      rpc(6, 'tools/call', { name: 'TOOL-CANARY-15', arguments: {} }),
    ]);
    // The results did carry the session text; the log must not.
    expect(JSON.stringify(run.responses[0])).toContain('RESULT-CANARY-15');
    const lines = run.stderr.trim().split('\n');
    expect(lines).toHaveLength(1 + 5);
    for (const canary of ['CANARY-15', PROJECT, 'acme-api', h.home, 'deploy']) {
      expect(run.stderr).not.toContain(canary);
    }
    for (const line of lines.slice(1)) {
      expect(line).toMatch(
        /^\[memory-mcp\] tool=\w+ scope=(project|all) candidates=\d+ returned=\d+ ms=\d+ bytes_read=\d+ partial=(true|false) bad_lines=\d+( error=\w+)?$/,
      );
    }
  });

  it('[C35] a project with no transcript folder gets the fixed no-transcripts text, never its path', async () => {
    const run = await runServer(
      [rpc(1, 'tools/call', { name: 'recent_work', arguments: {} })],
      '/Users/dev/never-ran-claude-here',
    );
    const res = run.responses[0]['result'] as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(NO_TRANSCRIPTS_TEXT);
    expect(JSON.stringify(run.responses)).not.toContain('never-ran-claude-here');
  });

  it('[C20] a corrupt transcript line is counted, never logged', async () => {
    const e = env(1);
    const file = h.writeSession(h.projectDir(), e, [
      prompt(e, h.now - HOUR, 'fix the parser'),
      said(e, h.now - HOUR + 1000, 'Fixed.'),
    ]);
    // Node's SyntaxError for this line quotes the text around the bad token.
    fs.appendFileSync(file, '{"type":"user","promptSource":"typed","message":Q7CNRY20}\n');
    fs.utimesSync(file, (h.now - HOUR + 2000) / 1000, (h.now - HOUR + 2000) / 1000);

    const run = await runServer([rpc(1, 'tools/call', { name: 'recent_work', arguments: {} })]);
    expect(run.stderr).not.toContain('Q7CNRY20');
    expect(run.stderr).toContain('bad_lines=1');
    expect(JSON.stringify(run.responses)).not.toContain('Q7CNRY20');
  });
});

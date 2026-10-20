import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentState } from '../src/types.js';

// A fake HOME: everything the server persists lands here, and nothing touches the real one.
let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

// The store reads the debug-log path once at import, so the env must be set before the imports.
tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-question-leak-'));
// The session transcript is the user's own file, outside the data dir the sweeps read.
const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-question-transcript-'));
const DEBUG_LOG = path.join(tempHome, 'debug.log');
process.env['PIXEL_AGENTS_DEBUG'] = '1';
process.env['PIXEL_AGENTS_DEBUG_LOG'] = DEBUG_LOG;

const { AgentStateStore } = await import('../src/agentStateStore.js');
const { FileStateAdapter } = await import('../src/fileStateAdapter.js');
const { HookEventHandler } = await import('../src/hookEventHandler.js');
const { claudeProvider } = await import('../src/providers/hook/claude/claude.js');
const { SessionRouter } = await import('../src/sessionRouter.js');
const { applyTurnDerivation, deriveAgentTurnState } = await import('../src/turnStateSeed.js');
const { resendAgentActivity } = await import('../src/agentActivityResend.js');

const SECRET = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
// Not a secret: it survives redaction, so it proves the question was live on the wire while
// the sweeps prove it never reached a log or a file.
const MARKER = 'zebracrossing';
const INPUT = { questions: [{ question: `Deploy ${MARKER} with ${SECRET}?` }] };

function createAgent(overrides: Partial<AgentState>): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    isExternal: true,
    projectDir: tempHome,
    jsonlFile: path.join(tempHome, 'session.jsonl'),
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    ...overrides,
  } as AgentState;
}

/** Every file under the fake HOME (state files, the debug log) as one string. */
function diskText(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else parts.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(tempHome);
  return parts.join('\n');
}

describe('the question text stays in memory', () => {
  const output: string[] = [];
  const wire: Array<Record<string, unknown>> = [];
  const store = new AgentStateStore();

  beforeAll(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      });
    }
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    store.on('broadcast', (m) => wire.push(m as Record<string, unknown>));
  });
  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  const sweep = () => {
    store.persist();
    // The sweeps are not vacuous: the state file and the debug log exist and hold the agents.
    expect(
      fs.readFileSync(path.join(tempHome, '.pixel-agents', 'standalone-state.json'), 'utf8'),
    ).toContain('sess-');
    expect(fs.readFileSync(DEBUG_LOG, 'utf8')).toContain('BCAST');
    for (const haystack of [diskText(), output.join('\n')]) {
      expect(haystack).not.toContain(SECRET);
      expect(haystack).not.toContain(MARKER);
    }
  };

  it('PreToolUse path: not in the console, the debug log or any persisted file', () => {
    const handler = new HookEventHandler(
      store,
      new Map(),
      new Map(),
      claudeProvider,
      new SessionRouter(),
    );
    store.set(1, createAgent({ id: 1, sessionId: 'sess-1' }));
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'AskUserQuestion',
      tool_input: INPUT,
    });

    const status = wire.filter((m) => m.type === 'agentStatus').at(-1);
    expect(status?.question).toContain(MARKER);
    expect(status?.question).not.toContain(SECRET);
    sweep();
  });

  it('adoption path: not in the console, the debug log or any persisted file', () => {
    const file = path.join(transcriptDir, 'session2.jsonl');
    const at = new Date().toISOString();
    fs.writeFileSync(
      file,
      [
        { type: 'user', timestamp: at, message: { content: 'go' } },
        {
          type: 'assistant',
          timestamp: at,
          message: {
            content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: INPUT }],
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const agent = createAgent({ id: 2, sessionId: 'sess-2', jsonlFile: file });
    store.set(2, agent);

    const derivation = deriveAgentTurnState(agent, claudeProvider);
    expect(derivation).not.toBeNull();
    applyTurnDerivation(agent, derivation!);

    const resent: Array<Record<string, unknown>> = [];
    resendAgentActivity((m) => {
      if (m.type === 'agentStatus' && m.id === 2) resent.push(m);
    }, store);
    expect(resent[0]?.question).toContain(MARKER);
    expect(resent[0]?.question).not.toContain(SECRET);
    sweep();
  });
});

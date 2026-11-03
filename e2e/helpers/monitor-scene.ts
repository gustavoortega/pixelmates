/**
 * The monitor scene (`?scene=monitor` on the dev SPA, webview-ui/src/heroScene.ts) as server
 * messages, for the standalone e2e: the dev scene is not in the served build, so a spec delivers
 * the same office through the page's socket (`window.__pixelAgentsDeliver`). Seven agents, two
 * waiting on the user, one stuck, a lead running a three-helper workflow, one with two
 * sub-agents, a loop asleep and one idle. Every time is relative to `baseMs`.
 */

const MIN = 60_000;
const WF_PREFIX = 'wf:';

/** Made-up session titles, one per agent. */
const TITLES: Record<string, string> = {
  Ada: 'Retry failed webhooks',
  Alan: 'Pick a date library',
  Grace: 'Fix the flaky cart test',
  Linus: 'Review the payments PR',
  Barbara: 'Split the VPN tunnel',
  Dennis: 'Bump the Node version',
  Hedy: 'Write the release notes',
};

const AGENTS = [
  { id: 1, name: 'Ada', folder: 'billing-api', branch: 'fix/retry-backoff', tier: 4, ctx: 620 },
  { id: 2, name: 'Alan', folder: 'web-app', branch: 'feat/date-picker', tier: 2, ctx: 68 },
  {
    id: 3,
    name: 'Grace',
    folder: 'checkout-service',
    branch: 'fix/flaky-cart-test',
    tier: 3,
    ctx: 156,
  },
  { id: 4, name: 'Linus', folder: 'api-gateway', branch: 'review/payments-pr', tier: 4, ctx: 910 },
  { id: 5, name: 'Barbara', folder: 'data-pipeline', branch: 'feat/events-v2', tier: 3, ctx: 90 },
  { id: 6, name: 'Dennis', folder: 'infra', branch: 'chore/deps-sweep', tier: 1, ctx: 36 },
  { id: 7, name: 'Hedy', folder: 'mobile-app', branch: 'main', tier: 2, ctx: 54 },
] as const;

/** The lead and its run, for specs that open its sheet. */
export const SCENE_LEAD_ID = 4;
export const SCENE_RUN_ID = 'monitor-run';
const HELPERS = [
  { agentId: 'a2', label: 'security pass' },
  { agentId: 'a3', label: 'api contract check' },
  { agentId: 'a4', label: 'test coverage' },
];
export const SCENE_AGENT_COUNT = AGENTS.length;
export const SCENE_HELPER_COUNT = HELPERS.length;

/**
 * Every agent's seat in the bundled office, so the scene is the same on every run. The lead sits
 * in the Studio with free desks around it for its three helpers; the two quiet agents (Dennis
 * asleep, Hedy idle) share the lounge sofa, one tile apart, so their tags start on top of each
 * other and the scene always has a collision to solve.
 */
const SEATS: Record<number, string> = {
  1: 'f-cozy-0039',
  2: 'f-cozy-0042',
  3: 'f-cozy-0031',
  4: 'f-cozy-0002',
  5: 'f-cozy-0047',
  6: 'f-cozy-0051',
  7: 'f-cozy-0051:1',
};

export function monitorSceneMessages(baseMs: number): Array<Record<string, unknown>> {
  const ago = (min: number) => baseMs - min * MIN;
  const seated = Object.keys(SEATS).map(Number);
  const out: Array<Record<string, unknown>> = [
    {
      type: 'existingAgents',
      agents: seated,
      agentMeta: Object.fromEntries(
        seated.map((id) => [String(id), { palette: id - 1, hueShift: 0, seatId: SEATS[id] }]),
      ),
      folderNames: Object.fromEntries(
        seated.map((id) => [String(id), AGENTS.find((a) => a.id === id)!.folder]),
      ),
      externalAgents: {},
    },
  ];
  for (const a of AGENTS) {
    out.push({
      type: 'agentCreated',
      id: a.id,
      folderName: a.folder,
      palette: a.id - 1,
      hueShift: 0,
    });
    out.push({ type: 'agentModel', id: a.id, model: `monitor-tier-${a.tier}`, tier: a.tier });
    out.push({
      type: 'agentContextUsage',
      id: a.id,
      contextTokens: a.ctx * 1000,
      maxContextTokens: a.tier === 4 ? 1_000_000 : 200_000,
    });
    out.push({
      type: 'agentRoster',
      id: a.id,
      memberId: `monitor-${a.name.toLowerCase()}`,
      name: a.name,
      level: 3 + a.id,
      xp: 40 * a.id,
      xpToNext: 400,
      streak: 0,
      mood: 'neutral',
    });
    out.push({ type: 'agentSession', id: a.id, startedAt: ago(40 + a.id), branch: a.branch });
    out.push({ type: 'agentSessionTitle', id: a.id, title: TITLES[a.name] });
  }
  // Ada: a permission prompt for `git push`.
  out.push({
    type: 'agentToolStart',
    id: 1,
    toolId: 'm-1',
    status: 'Running: git push',
    toolName: 'Bash',
  });
  out.push({ type: 'agentStatus', id: 1, status: 'active', since: ago(31) });
  out.push({ type: 'agentToolPermission', id: 1, permissionSince: ago(12) });
  // Alan: a question.
  out.push({ type: 'agentStatus', id: 2, status: 'waiting', awaitingInput: true, since: ago(4) });
  // Grace: stuck on failing tests.
  out.push({
    type: 'agentToolStart',
    id: 3,
    toolId: 'm-3',
    status: 'Running: npm test',
    toolName: 'Bash',
  });
  out.push({ type: 'agentStatus', id: 3, status: 'active', since: ago(26) });
  out.push({
    type: 'agentHealth',
    id: 3,
    state: 'stuck',
    reason: 'tests_failing_no_edits',
    count: 4,
    since: ago(9),
  });
  // Linus: leads the workflow.
  out.push({
    type: 'agentToolStart',
    id: 4,
    toolId: 'm-4',
    status: 'Using Workflow',
    toolName: 'Workflow',
  });
  out.push({ type: 'agentStatus', id: 4, status: 'active', since: ago(21) });
  for (const h of HELPERS) {
    out.push({
      type: 'subagentPresent',
      id: SCENE_LEAD_ID,
      parentToolId: `${WF_PREFIX}${SCENE_RUN_ID}:${h.agentId}`,
      label: h.label,
      group: 'review',
    });
  }
  out.push({
    type: 'workflowRun',
    id: SCENE_LEAD_ID,
    runId: SCENE_RUN_ID,
    status: 'running',
    name: 'review-pr',
    phases: [
      { name: 'scan', started: 1, done: 1 },
      { name: 'review', started: 3, done: 0 },
    ],
    started: 4,
    done: 1,
    since: ago(21),
  });
  // Barbara: two sub-agents.
  for (const [n, task, tool] of [
    [1, 'Map the call sites', 'Reading events.ts'],
    [2, 'Draft the migration', 'Editing migrate.sql'],
  ] as const) {
    const toolId = `m-5-sub-${n}`;
    out.push({
      type: 'agentToolStart',
      id: 5,
      toolId,
      status: `Subtask: ${task}`,
      toolName: 'Agent',
    });
    out.push({
      type: 'subagentToolStart',
      id: 5,
      parentToolId: toolId,
      toolId: `${toolId}-tool`,
      status: tool,
    });
  }
  out.push({ type: 'agentStatus', id: 5, status: 'active', since: ago(14) });
  // Dennis: a loop asleep; Hedy: idle.
  out.push({ type: 'agentStatus', id: 6, status: 'idle', since: ago(15) });
  out.push({ type: 'agentLoop', id: 6, nextAt: baseMs + 25 * MIN, wakes: 3 });
  out.push({ type: 'agentStatus', id: 7, status: 'idle', since: ago(68) });
  return out;
}

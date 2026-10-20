import type { HookProvider, SessionLiveness } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { HEALTH_TICK_MS } from './constants.js';
import { tickHealth } from './health.js';
import { transcriptClockMs } from './turnStateSeed.js';

export interface HealthTickDeps {
  store: AgentStateStore;
  provider: HookProvider;
  /** Remove a dead external agent the way a session end removes one. */
  removeDeadAgent: (agentId: number) => void;
}

/** Error kinds already logged: a tick failing the same way every 30 s says it once. */
const loggedErrorKinds = new Set<string>();

function logOnce(err: unknown): void {
  const kind = (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? 'unknown';
  if (loggedErrorKinds.has(kind)) return;
  loggedErrorKinds.add(kind);
  console.error(`[pixelmates] Health tick failed (${kind}): ${(err as Error)?.message ?? err}`);
}

/**
 * One health tick over every agent: ask the provider which sessions still have a process,
 * judge stalls for agents with an open turn, remove external agents dead long enough, then
 * compare and broadcast what changed. Never throws.
 */
export async function runHealthTick(deps: HealthTickDeps, now = Date.now()): Promise<void> {
  try {
    const sessionIds = new Set<string>();
    for (const agent of deps.store.values()) {
      if (agent.sessionId) sessionIds.add(agent.sessionId);
    }
    const liveness =
      deps.provider.liveness && sessionIds.size > 0
        ? await deps.provider.liveness([...sessionIds])
        : new Map<string, SessionLiveness>();
    const traits = deps.provider.turnTraits;
    // Read the store again: agents may have come or gone while the provider answered.
    for (const [id, agent] of [...deps.store]) {
      // Removing a lead removes its teammates with it.
      if (deps.store.get(id) !== agent) continue;
      try {
        const remove = tickHealth(
          agent,
          deps.store,
          traits,
          (agent.sessionId && liveness.get(agent.sessionId)) || 'unknown',
          () => (agent.jsonlFile ? transcriptClockMs(agent.jsonlFile) : 0),
          now,
        );
        if (remove) deps.removeDeadAgent(id);
      } catch (err) {
        logOnce(err);
      }
    }
  } catch (err) {
    logOnce(err);
  }
}

/** Run the tick every HEALTH_TICK_MS, in hooks and heuristic mode alike. A tick still waiting
 *  on the provider is not overlapped. Unref'd: it never keeps the process alive. */
export function startHealthTick(deps: HealthTickDeps): ReturnType<typeof setInterval> {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runHealthTick(deps).finally(() => {
      running = false;
    });
  }, HEALTH_TICK_MS);
  timer.unref?.();
  return timer;
}

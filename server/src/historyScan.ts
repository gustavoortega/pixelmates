import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { HISTORY_SCAN_MAX_BYTES, HISTORY_SCAN_WALL_MS, SHADOW_ID_BASE } from './constants.js';
import { Budget, scanLines } from './memory/reader.js';
import {
  absorbHistory,
  currentTracker,
  feedFacts,
  type MonitorTracker,
  newFacts,
  publishMonitor,
  trackerOf,
} from './monitorFacts.js';
import type { AgentState } from './types.js';

/**
 * What an agent adopted past the start of its transcript missed: the artifacts it published,
 * the loop it scheduled, its last test run. Live parsing starts at the watch offset, so
 * without this a restored or adopted session would show none of it until it did it again.
 *
 * One streaming read of 0..offset per agent (memory/reader.ts: lines over 1 MiB are skipped
 * unread, every byte is charged), feeding the same reducer as the live parser. Scans run one
 * at a time from one queue, so adopting twenty sessions at startup never reads twenty files
 * at once, and each agent's messages go out when its own scan ends. A scan the budget stops
 * is `complete: false`: counts become floors and per-url publishes are left out.
 */

/** What a consumer is told about the agent whose history is being read. `offset` is where the
 *  live parser takes over: the scan reads 0..offset and no further. */
export interface HistoryScanContext {
  agents: AgentStateStore;
  agent: AgentState;
  provider: HookProvider;
  /** The transcript being read: the agent may have moved to another since. */
  file: string;
  offset: number;
}

/** Something else that reads an agent's history in the same pass (the session cost reducer).
 *  `begin` runs when the scan is queued, so a consumer can hold back what the live path would
 *  show on its own. Records arrive parsed, in file order, only those before the offset. `done`
 *  runs exactly once per `begin`, even when the scan was skipped (the agent left or moved to
 *  another transcript) or failed: `complete` is false when the budget cut it or the file could
 *  not be read. */
export interface HistoryConsumer {
  begin?(agentId: number, ctx: HistoryScanContext): void;
  record(agentId: number, record: unknown, ctx: HistoryScanContext): void;
  done?(agentId: number, complete: boolean, ctx: HistoryScanContext): void;
}

const consumers: HistoryConsumer[] = [];

/** Join the history pass. Returns the function that leaves it. */
export function registerHistoryConsumer(consumer: HistoryConsumer): () => void {
  consumers.push(consumer);
  return () => {
    const at = consumers.indexOf(consumer);
    if (at >= 0) consumers.splice(at, 1);
  };
}

interface ScanJob {
  agentId: number;
  agent: AgentState;
  agents: AgentStateStore;
  provider: HookProvider;
  tracker: MonitorTracker;
  file: string;
  offset: number;
  /** The consumers that were told `begin`: they, and only they, hear the rest. */
  consumers: HistoryConsumer[];
  ended: boolean;
}

const queue: ScanJob[] = [];
let draining = false;

/**
 * Queue the history scan of an agent that starts at `fileOffset > 0`. At offset 0 the live
 * replay reads every record, so there is nothing to scan. Once per transcript.
 */
export function scheduleHistoryScan(
  agentId: number,
  agents: AgentStateStore,
  provider: HookProvider | null | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent || !readsHistory(agentId, agent, provider) || !provider) return;
  const tracker = trackerOf(agent);
  if (tracker.scanRequested) return;
  tracker.scanRequested = true;
  tracker.scanning = true;
  const job: ScanJob = {
    agentId,
    agent,
    agents,
    provider,
    tracker,
    file: agent.jsonlFile,
    offset: agent.fileOffset,
    consumers: [...consumers],
    ended: false,
  };
  for (const consumer of job.consumers) {
    try {
      consumer.begin?.(agentId, contextOf(job));
    } catch {
      // One consumer's bug must not stop the others.
    }
  }
  queue.push(job);
  void drain();
}

function contextOf(job: ScanJob): HistoryScanContext {
  return {
    agents: job.agents,
    agent: job.agent,
    provider: job.provider,
    file: job.file,
    offset: job.offset,
  };
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        await runJob(job);
      } catch {
        // A scan that fails leaves the agent with what the live path reads.
        endScan(job, newFacts(), false);
      }
    }
  } finally {
    draining = false;
  }
}

async function runJob(job: ScanJob): Promise<void> {
  // Removed, or moved to another transcript, while queued.
  if (currentTracker(job.agent) !== job.tracker || !job.agents.has(job.agentId)) {
    endScan(job, newFacts(), false);
    return;
  }
  const budget = new Budget(HISTORY_SCAN_WALL_MS, HISTORY_SCAN_MAX_BYTES);
  const history = newFacts();
  const outcome = await scanLines(
    job.file,
    budget,
    (line) => {
      let record: unknown;
      try {
        record = JSON.parse(line.toString('utf8'));
      } catch {
        return;
      }
      feedFacts(history, record, job.provider);
      for (const consumer of job.consumers) {
        try {
          consumer.record(job.agentId, record, contextOf(job));
        } catch {
          // One consumer's bug must not end the pass for the others.
        }
      }
    },
    job.offset,
  );
  endScan(job, history, outcome === true);
}

function endScan(job: ScanJob, history: ReturnType<typeof newFacts>, complete: boolean): void {
  if (job.ended) return;
  job.ended = true;
  const { agent, agentId, agents, tracker } = job;
  if (currentTracker(agent) === tracker && agents.has(agentId)) {
    absorbHistory(tracker.facts, history);
    tracker.complete = complete;
    tracker.scanning = false;
    if (!complete) {
      // Counts only: what the file holds never reaches the log.
      console.log(`[pixelmates] Agent ${agentId}: history scan stopped early`);
    }
    try {
      publishMonitor(agentId, agent, agents, tracker);
    } catch {
      // The consumers below still have to hear that it ended.
    }
  }
  for (const consumer of job.consumers) {
    try {
      consumer.done?.(agentId, complete, contextOf(job));
    } catch {
      // See above.
    }
  }
}

/** Whether `scheduleHistoryScan` will queue a scan for this agent: it starts mid-file, so the
 *  records before its offset are not the live parser's. */
export function readsHistory(
  agentId: number,
  agent: AgentState,
  provider: HookProvider | null | undefined,
): boolean {
  return !!provider && agentId < SHADOW_ID_BASE && !!agent.jsonlFile && agent.fileOffset > 0;
}

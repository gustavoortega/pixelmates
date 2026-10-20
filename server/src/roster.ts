/**
 * Roster: a persistent crew of named members that agents take on while they live.
 *
 * Identity follows the member, not the agent id, so XP and the look survive restarts and /clear.
 * The file is shared by every pixelmates process on the machine (VS Code and standalone can run
 * together), so each write re-reads the file under a lockfile and applies this process's deltas on
 * top. Holds record which live process has which member; a hold whose pid is dead is free.
 *
 * Counts only: the file never holds titles, commands or paths beyond the folder name the map shows.
 * Everything here is synchronous: agent creation sites need the palette before they store the agent.
 */

import * as fs from 'fs';
import * as path from 'path';

import { pickDiversePalette } from '../../core/src/paletteUtils.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  ROSTER_FLUSH_DEBOUNCE_MS,
  ROSTER_LOCK_RETRIES,
  ROSTER_LOCK_RETRY_MS,
  ROSTER_LOCK_STALE_MS,
} from './constants.js';
import { getPaletteCount } from './paletteAssigner.js';
import type { MemberChange } from './xp.js';

export interface RosterMember {
  id: string;
  name: string;
  palette: number;
  hueShift: number;
  xp: number;
  /** Awards since the last failed tool, and failed tools in a row; stored so mood survives a
   *  restart. Files written before XP paid for real work keep their old streak, which the next
   *  failed tool resets. */
  streak: number;
  consecutiveFailures: number;
  lastFolder?: string;
  lastSessionId?: string;
  releasedAt?: number;
  createdAt: number;
}

export interface RosterHold {
  memberId: string;
  pid: number;
  agentId: number;
  sessionId: string;
  since: number;
}

interface RosterFile {
  version: 1;
  members: RosterMember[];
  holds: RosterHold[];
}

export interface RosterOptions {
  filePath: string;
  /** Injected so tests can run two "processes" in one. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  paletteCount?: () => number;
  lockRetries?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
  debounceMs?: number;
}

export interface ClaimInput {
  agentId: number;
  sessionId: string;
  rosterId?: string;
  folderName?: string;
}

/** Fixed pool, in hire order. Exhausted -> "Agent <n>". */
export const NAME_POOL: readonly string[] = [
  'Ada',
  'Alan',
  'Barbara',
  'Brian',
  'Carol',
  'Dennis',
  'Edsger',
  'Ellen',
  'Frances',
  'Grace',
  'Guido',
  'Hedy',
  'Ivan',
  'Jean',
  'Ken',
  'Katherine',
  'Linus',
  'Leslie',
  'Margaret',
  'Niklaus',
  'Nadia',
  'Olga',
  'Radia',
  'Rob',
  'Sophie',
  'Tim',
  'Ursula',
  'Vint',
  'Wendy',
  'Yukihiro',
  'Zuzana',
  'Anita',
  'Bjarne',
  'Cleo',
  'Donald',
  'Evelyn',
  'Fernando',
  'Gwen',
  'Hal',
  'Iris',
  'Joan',
  'Kristen',
  'Lena',
  'Marvin',
  'Nikolai',
  'Orla',
  'Priya',
  'Quinn',
];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function str(v: unknown, max = 80): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

/** Keep only the fields we own, so a hand-edited or newer file cannot smuggle anything through. */
function cleanMember(raw: unknown): RosterMember | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 32);
  const name = str(r.name, 40);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    palette: count(r.palette),
    hueShift: count(r.hueShift),
    xp: count(r.xp),
    streak: count(r.streak),
    consecutiveFailures: count(r.consecutiveFailures),
    lastFolder: str(r.lastFolder, 200),
    lastSessionId: str(r.lastSessionId, 80),
    releasedAt: typeof r.releasedAt === 'number' ? r.releasedAt : undefined,
    createdAt: count(r.createdAt),
  };
}

function cleanHold(raw: unknown): RosterHold | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const memberId = str(r.memberId, 32);
  if (!memberId || typeof r.pid !== 'number' || typeof r.agentId !== 'number') {
    return null;
  }
  return {
    memberId,
    pid: r.pid,
    agentId: r.agentId,
    sessionId: str(r.sessionId, 80) ?? '',
    since: count(r.since),
  };
}

function applyChange(member: RosterMember, change: MemberChange): void {
  member.xp += change.xp ?? 0;
  if (change.streak !== undefined) {
    member.streak = change.streak;
  }
  if (change.consecutiveFailures !== undefined) {
    member.consecutiveFailures = change.consecutiveFailures;
  }
}

function mergeChange(into: MemberChange, change: MemberChange): void {
  into.xp = (into.xp ?? 0) + (change.xp ?? 0);
  if (change.streak !== undefined) {
    into.streak = change.streak;
  }
  if (change.consecutiveFailures !== undefined) {
    into.consecutiveFailures = change.consecutiveFailures;
  }
}

/** Least recently released first; never released counts as oldest. Ties keep file order. */
function leastRecentlyReleased(members: RosterMember[]): RosterMember | undefined {
  let best: RosterMember | undefined;
  for (const m of members) {
    if (!best || (m.releasedAt ?? 0) < (best.releasedAt ?? 0)) {
      best = m;
    }
  }
  return best;
}

export class RosterStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly paletteCount: () => number;
  private readonly lockRetries: number;
  private readonly lockRetryMs: number;
  private readonly lockStaleMs: number;
  private readonly debounceMs: number;

  /** Last file state this process wrote or read, plus its unflushed deltas. */
  private view: RosterFile = { version: 1, members: [], holds: [] };
  private readonly pending = new Map<string, MemberChange>();
  /** agentId -> memberId for agents this process holds. */
  private readonly held = new Map<number, string>();
  /** Releases that could not take the lock; retried on the next write. */
  private readonly pendingReleases = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tmpCounter = 0;

  constructor(opts: RosterOptions) {
    this.filePath = opts.filePath;
    this.lockPath = opts.filePath + '.lock';
    this.pid = opts.pid ?? process.pid;
    this.isAlive = opts.isAlive ?? pidAlive;
    this.now = opts.now ?? Date.now;
    this.paletteCount = opts.paletteCount ?? getPaletteCount;
    this.lockRetries = opts.lockRetries ?? ROSTER_LOCK_RETRIES;
    this.lockRetryMs = opts.lockRetryMs ?? ROSTER_LOCK_RETRY_MS;
    this.lockStaleMs = opts.lockStaleMs ?? ROSTER_LOCK_STALE_MS;
    this.debounceMs = opts.debounceMs ?? ROSTER_FLUSH_DEBOUNCE_MS;
  }

  /** Hook this roster to a store: members are released when their agent leaves it. */
  attach(store: AgentStateStore): void {
    store.roster = this;
    store.on('agentRemoved', (id) => this.release(id));
  }

  getMember(id: string): Readonly<RosterMember> | undefined {
    return this.view.members.find((m) => m.id === id);
  }

  /**
   * Give an agent a member. Undefined when the file lock could not be taken: the caller then
   * falls back to the plain palette assigner and the agent simply plays without a roster seat.
   */
  claim(input: ClaimInput): RosterMember | undefined {
    const done = this.transact((file) => {
      const mine = file.holds.find((h) => h.pid === this.pid && h.agentId === input.agentId);
      if (mine) {
        mine.sessionId = input.sessionId;
        const member = file.members.find((m) => m.id === mine.memberId);
        if (member) {
          member.lastSessionId = input.sessionId;
          return member;
        }
        file.holds.splice(file.holds.indexOf(mine), 1);
      }

      const heldIds = new Set(file.holds.map((h) => h.memberId));
      const free = file.members.filter((m) => !heldIds.has(m.id));
      // A session keeps its member across restarts, /clear and scan-before-restore races. Only
      // FREE members are matched: a live hold in any process is never taken.
      let member = input.sessionId
        ? free.find((m) => m.lastSessionId === input.sessionId)
        : undefined;
      if (!member && input.rosterId) {
        member = free.find((m) => m.id === input.rosterId);
      }
      if (!member && input.folderName) {
        // Spread XP across the crew: prefer the member who has been out longest for this folder.
        member = leastRecentlyReleased(free.filter((m) => m.lastFolder === input.folderName));
      }
      member ??= leastRecentlyReleased(free);
      member ??= this.hire(file);

      if (input.folderName) {
        member.lastFolder = input.folderName;
      }
      member.lastSessionId = input.sessionId;
      file.holds.push({
        memberId: member.id,
        pid: this.pid,
        agentId: input.agentId,
        sessionId: input.sessionId,
        since: this.now(),
      });
      return member;
    });
    if (!done.ok) {
      return undefined;
    }
    this.held.set(input.agentId, done.value.id);
    return this.view.members.find((m) => m.id === done.value.id);
  }

  /** The agent left the store: free its member. */
  release(agentId: number): void {
    if (!this.held.has(agentId) && !this.pendingReleases.has(agentId)) {
      return;
    }
    this.pendingReleases.set(agentId, this.now());
    this.held.delete(agentId);
    this.transact(() => undefined);
  }

  /** The agent's session changed (/clear, resume): the hold and the member follow it. */
  rebindSession(agentId: number, sessionId: string): void {
    if (!this.held.has(agentId)) {
      return;
    }
    this.transact((file) => {
      const hold = file.holds.find((h) => h.pid === this.pid && h.agentId === agentId);
      if (!hold) {
        return;
      }
      hold.sessionId = sessionId;
      const member = file.members.find((m) => m.id === hold.memberId);
      if (member) {
        member.lastSessionId = sessionId;
      }
    });
  }

  /** Record XP and counters. Applied to the view now, written on the next flush. */
  award(memberId: string, change: MemberChange): void {
    const member = this.view.members.find((m) => m.id === memberId);
    if (!member) {
      return;
    }
    applyChange(member, change);
    let into = this.pending.get(memberId);
    if (!into) {
      into = {};
      this.pending.set(memberId, into);
    }
    mergeChange(into, change);
    this.schedule();
  }

  /** Write pending deltas now. False when the lock was not available; they stay pending. */
  flush(): boolean {
    if (this.pending.size === 0 && this.pendingReleases.size === 0) {
      return true;
    }
    return this.transact(() => undefined).ok;
  }

  dispose(): void {
    this.flush();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref();
  }

  private hire(file: RosterFile): RosterMember {
    let n = 0;
    for (const m of file.members) {
      const num = Number(m.id.slice(1));
      if (Number.isFinite(num) && num > n) {
        n = num;
      }
    }
    n += 1;
    const taken = new Set(file.members.map((m) => m.name));
    const name = NAME_POOL.find((candidate) => !taken.has(candidate)) ?? `Agent ${n}`;
    const total = Math.max(1, this.paletteCount());
    const counts = new Array<number>(total).fill(0);
    for (const m of file.members) {
      if (m.palette < total) {
        counts[m.palette]++;
      }
    }
    const pick = pickDiversePalette(total, counts);
    const member: RosterMember = {
      id: `m${n}`,
      name,
      palette: pick.palette,
      hueShift: pick.hueShift,
      xp: 0,
      streak: 0,
      consecutiveFailures: 0,
      createdAt: this.now(),
    };
    file.members.push(member);
    return member;
  }

  /**
   * One locked read-modify-write: fresh copy from disk, dead holds dropped, this process's
   * pending releases and deltas applied, then `fn`. Never throws.
   */
  private transact<T>(fn: (file: RosterFile) => T): { ok: true; value: T } | { ok: false } {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch {
      return { ok: false };
    }
    if (!this.acquireLock()) {
      console.warn('[pixelmates] Roster: lock busy, skipping write');
      return { ok: false };
    }
    try {
      const file = this.read();
      file.holds = file.holds.filter((h) => this.isAlive(h.pid));
      for (const [agentId, at] of this.pendingReleases) {
        const i = file.holds.findIndex((h) => h.pid === this.pid && h.agentId === agentId);
        if (i >= 0) {
          const [hold] = file.holds.splice(i, 1);
          const member = file.members.find((m) => m.id === hold.memberId);
          if (member) {
            member.releasedAt = at;
          }
        }
      }
      for (const [memberId, change] of this.pending) {
        const member = file.members.find((m) => m.id === memberId);
        if (member) {
          applyChange(member, change);
        }
      }
      const value = fn(file);
      this.write(file);
      this.view = file;
      this.pending.clear();
      this.pendingReleases.clear();
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return { ok: true, value };
    } catch (err) {
      console.error('[pixelmates] Roster: write failed:', err);
      return { ok: false };
    } finally {
      this.releaseLock();
    }
  }

  private read(): RosterFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return { version: 1, members: [], holds: [] };
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.version !== 1) {
        throw new Error('unsupported version');
      }
      const members = (Array.isArray(parsed.members) ? parsed.members : [])
        .map(cleanMember)
        .filter((m): m is RosterMember => m !== null);
      const holds = (Array.isArray(parsed.holds) ? parsed.holds : [])
        .map(cleanHold)
        .filter((h): h is RosterHold => h !== null);
      return { version: 1, members, holds };
    } catch (err) {
      // Keep the unreadable file for the user rather than silently overwriting their XP.
      console.error('[pixelmates] Roster: unreadable file, starting fresh:', err);
      try {
        fs.copyFileSync(this.filePath, `${this.filePath}.corrupt`);
      } catch {
        /* best effort */
      }
      return { version: 1, members: [], holds: [] };
    }
  }

  private write(file: RosterFile): void {
    const out: RosterFile = {
      version: 1,
      members: file.members.map((m) => ({
        id: m.id,
        name: m.name,
        palette: m.palette,
        hueShift: m.hueShift,
        xp: m.xp,
        streak: m.streak,
        consecutiveFailures: m.consecutiveFailures,
        lastFolder: m.lastFolder,
        lastSessionId: m.lastSessionId,
        releasedAt: m.releasedAt,
        createdAt: m.createdAt,
      })),
      holds: file.holds,
    };
    const tmp = `${this.filePath}.${this.pid}.${process.pid}.${this.tmpCounter++}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  private acquireLock(): boolean {
    for (let attempt = 0; attempt <= this.lockRetries; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeSync(fd, String(this.pid));
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          return false;
        }
      }
      this.breakStaleLock();
      if (attempt < this.lockRetries) {
        sleepSync(this.lockRetryMs);
      }
    }
    return false;
  }

  /**
   * A lock is stale when its owner is dead. Age alone never breaks a readable lock: a slow
   * writer that is still alive would lose it mid-write. Only an unreadable lockfile (the owner
   * died between create and write) falls back to age. A narrow race remains where two breakers
   * both see the same dead owner; the next write re-reads, so only a lost lock, not data, is at stake.
   */
  private breakStaleLock(): void {
    try {
      const owner = Number.parseInt(fs.readFileSync(this.lockPath, 'utf-8'), 10);
      if (Number.isInteger(owner) && owner > 0) {
        if (!this.isAlive(owner)) {
          fs.unlinkSync(this.lockPath);
        }
        return;
      }
      if (this.now() - fs.statSync(this.lockPath).mtimeMs > this.lockStaleMs) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      /* gone already, or not ours to break */
    }
  }

  private releaseLock(): void {
    try {
      // Another process may have broken and retaken the lock while we were slow.
      if (fs.readFileSync(this.lockPath, 'utf-8').trim() === String(this.pid)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      /* already gone */
    }
  }
}

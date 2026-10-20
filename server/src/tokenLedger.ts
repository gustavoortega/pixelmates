import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TokenUsage, TokenWindow } from '../../core/src/messages.js';
import type {
  QuotaSignal,
  TranscriptUsageSource,
  UsageLine,
  UsageTranscript,
} from '../../core/src/provider.js';
import {
  LAYOUT_FILE_DIR,
  TOKEN_LEDGER_CACHE_FILE,
  TOKEN_LEDGER_CACHE_FLUSH_MS,
  TOKEN_LEDGER_READ_HIGH_WATER_MARK,
  TOKEN_LEDGER_TICK_MS,
  TOKEN_LEDGER_WINDOW_MS,
} from './constants.js';
import { folderNameFromProjectDir } from './folderName.js';
import type { LedgerRecord, QuotaAnchor, QuotaState, Usage4 } from './tokenAggregate.js';
import { aggregateWindow, biggestBlockTotal, resolveWindows } from './tokenAggregate.js';

/**
 * Token ledger: totals the tokens a CLI's transcripts report, per area and per session, over a 5-hour block and a
 * week. It only reads (streams, one file at a time, yielding to the event loop between files), re-reads only the
 * bytes appended since the last pass, and keeps its progress in `~/.pixelmates/ledger-cache.json`.
 *
 * Everything CLI-specific lives behind `TranscriptUsageSource`; this module sees `UsageLine`s.
 */

const NEWLINE = 0x0a;
const CACHE_VERSION = 1;

interface FileProgress {
  offset: number;
  size: number;
  mtimeMs: number;
}

interface CacheShape {
  version: number;
  files: Record<string, FileProgress>;
  records: Record<string, { ts: number; s: string; x?: string[]; f: string; m: string; u: Usage4 }>;
  sessions: Record<string, number>;
  titles: Record<string, { c?: string; a?: string }>;
  quota: QuotaState;
}

export interface TokenBudgets {
  budget5h?: number;
  budgetWeek?: number;
}

export interface TokenLedgerOptions {
  source: TranscriptUsageSource;
  /** Where the area mappings live right now (read on every aggregation). */
  getAreaMappings: () => Record<string, string[]>;
  getBudgets: () => TokenBudgets;
  /** Receives every changed aggregate (never more often than once per tick, except on first completion / refresh). */
  onChange: (message: TokenUsage) => void;
  /** Defaults to `<home>/.pixelmates/ledger-cache.json`. Tests always pass a temp path. */
  cachePath?: string;
  /** Defaults to `source.usageRoot()`. Tests always pass a temp dir. */
  root?: string;
  now?: () => number;
  tickMs?: number;
  flushMs?: number;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isUsage4(u: unknown): u is Usage4 {
  return (
    Array.isArray(u) &&
    u.length === 4 &&
    u.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

const QUOTA_WINDOWS: readonly QuotaSignal['window'][] = ['block', 'week'];

function isQuotaAnchor(q: unknown): q is QuotaAnchor {
  if (!q || typeof q !== 'object') return false;
  const { ts, resetsAt } = q as Record<string, unknown>;
  return (
    typeof ts === 'number' &&
    Number.isFinite(ts) &&
    typeof resetsAt === 'number' &&
    Number.isFinite(resetsAt)
  );
}

export class TokenLedger {
  private readonly files = new Map<string, FileProgress>();
  private readonly records = new Map<string, LedgerRecord>();
  /** First (earliest) record timestamp of every session seen, for attribution. */
  private readonly sessionFirst = new Map<string, number>();
  private readonly titles = new Map<string, { c?: string; a?: string }>();
  private quota: QuotaState = {};

  private scanning = true;
  private running = false;
  private disposed = false;
  private dirty = false;
  private cacheLoaded = false;
  private lastEmitted = '';
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private readonly source: TranscriptUsageSource;
  private readonly root: string;
  private readonly cachePath: string;
  private readonly now: () => number;

  constructor(private readonly options: TokenLedgerOptions) {
    this.source = options.source;
    this.root = options.root ?? options.source.usageRoot();
    this.cachePath =
      options.cachePath ?? path.join(os.homedir(), LAYOUT_FILE_DIR, TOKEN_LEDGER_CACHE_FILE);
    this.now = options.now ?? Date.now;
  }

  /** Begin the initial pass in the background, then re-read appended bytes every tick. Never blocks the caller. */
  start(): void {
    if (this.tickTimer || this.disposed) return;
    void this.runPass().catch((err: unknown) => {
      console.error('[pixelmates] Token ledger scan failed:', err);
    });
    this.tickTimer = setInterval(() => {
      void this.runPass().catch((err: unknown) => {
        console.error('[pixelmates] Token ledger scan failed:', err);
      });
    }, this.options.tickMs ?? TOKEN_LEDGER_TICK_MS);
    this.tickTimer.unref();
    this.flushTimer = setInterval(() => {
      void this.flushCache(false);
    }, this.options.flushMs ?? TOKEN_LEDGER_CACHE_FLUSH_MS);
    this.flushTimer.unref();
  }

  /** Stop timers and write the cache synchronously: the process exits right after this returns. */
  dispose(): void {
    this.disposed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.tickTimer = this.flushTimer = null;
    void this.flushCache(true);
  }

  /** One scan pass: load the cache on the first call, read new bytes, prune, and emit when the aggregate changed. */
  async runPass(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      if (!this.cacheLoaded) {
        this.cacheLoaded = true;
        await this.loadCache();
      }
      const now = this.now();
      const transcripts = await this.source.listTranscripts(
        this.root,
        now - TOKEN_LEDGER_WINDOW_MS,
      );
      for (const t of transcripts) {
        if (this.disposed) return;
        await yieldToEventLoop();
        await this.readTranscript(t, now);
      }
      this.prune(transcripts, now);
      const wasScanning = this.scanning;
      this.scanning = false;
      this.emitIfChanged(wasScanning);
    } finally {
      this.running = false;
    }
  }

  /** Re-aggregate and emit now (budgets or area mappings changed). */
  refresh(): void {
    this.emitIfChanged(true);
  }

  /** A reset time reported outside the transcripts (the status line's official limits). Same rule as a transcript
   *  quota record, so the window it anchors reads `quota`; emitted only when the aggregate changed. */
  anchorQuota(quota: QuotaSignal): void {
    if (!this.ingestQuota(quota)) return;
    this.dirty = true;
    this.emitIfChanged(false);
  }

  /** The current message, for a client that just connected. */
  snapshot(): TokenUsage {
    const now = this.now();
    const budgets = this.options.getBudgets();
    const base: TokenUsage = {
      type: 'tokenUsage',
      generatedAt: now,
      ...(budgets.budget5h !== undefined && { budget5h: budgets.budget5h }),
      ...(budgets.budgetWeek !== undefined && { budgetWeek: budgets.budgetWeek }),
    };
    // Partial is not total: no windows and no ranking until the first pass has covered every file.
    if (this.scanning) return { ...base, scanning: true };

    const sorted = [...this.records.values()].sort((a, b) => a.ts - b.ts);
    const windows = resolveWindows(
      sorted.map((r) => r.ts),
      this.quota,
      now,
    );
    const titles = new Map<string, string>();
    for (const [sid, t] of this.titles) {
      const title = t.c ?? t.a;
      if (title) titles.set(sid, title);
    }
    const ctx = {
      sessionFirst: this.sessionFirst,
      titles,
      mappings: this.options.getAreaMappings(),
    };
    const window = (
      spec: { source: 'quota' | 'estimated'; start: number; end: number },
      budget: number | undefined,
    ): TokenWindow => {
      const totals = aggregateWindow(sorted, spec, { ...ctx, budget });
      return {
        source: spec.source,
        start: spec.start,
        end: spec.end,
        ...totals,
        ...(budget !== undefined && { budgetPct: totals.total / budget }),
      };
    };
    const biggest = biggestBlockTotal(sorted, now);
    return {
      ...base,
      ...(windows.block && { block: window(windows.block, budgets.budget5h) }),
      week: window(windows.week, budgets.budgetWeek),
      ...(biggest !== undefined && { biggestBlock: biggest }),
    };
  }

  // ── Reading ──────────────────────────────────────────────

  private async readTranscript(t: UsageTranscript, now: number): Promise<void> {
    const prev = this.files.get(t.path);
    let start = prev?.offset ?? 0;
    // Smaller than what was consumed: truncated or replaced, read it again from the top.
    if (prev && t.size < prev.offset) start = 0;
    else if (prev && prev.size === t.size && prev.mtimeMs === t.mtimeMs) return;

    const minTs = now - TOKEN_LEDGER_WINDOW_MS;
    let consumed = 0;
    let carry: Buffer = Buffer.alloc(0);
    try {
      const stream = fs.createReadStream(t.path, {
        start,
        highWaterMark: TOKEN_LEDGER_READ_HIGH_WATER_MARK,
      });
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        const lastNl = buf.lastIndexOf(NEWLINE);
        if (lastNl < 0) {
          carry = buf;
          continue;
        }
        let lineStart = 0;
        while (lineStart <= lastNl) {
          const nl = buf.indexOf(NEWLINE, lineStart);
          if (nl > lineStart) this.ingestLine(buf.subarray(lineStart, nl), t, minTs);
          lineStart = nl + 1;
        }
        consumed += lastNl + 1;
        // Copy: a subarray would keep the whole 1 MB chunk alive.
        carry = Buffer.from(buf.subarray(lastNl + 1));
      }
    } catch {
      return; // vanished or unreadable mid-pass; the next pass lists it again or prunes it
    }
    // The offset only advances over complete lines, so a half-written trailing line is read whole next time.
    this.files.set(t.path, { offset: start + consumed, size: t.size, mtimeMs: t.mtimeMs });
    this.dirty = true;
  }

  private ingestLine(line: Buffer, t: UsageTranscript, minTs: number): void {
    if (!this.source.linePrefilters.some((p) => line.includes(p))) return;
    const parsed = this.source.parseUsageLine(line.toString('utf8'), t.fallbackSessionId);
    if (parsed) this.ingest(parsed, t, minTs);
  }

  private ingest(line: UsageLine, t: UsageTranscript, minTs: number): void {
    if (line.title) {
      const cur = this.titles.get(line.title.sessionId) ?? {};
      if (line.title.customTitle) cur.c = line.title.customTitle;
      if (line.title.aiTitle) cur.a = line.title.aiTitle;
      this.titles.set(line.title.sessionId, cur);
    }
    if (line.quota) this.ingestQuota(line.quota);
    const u = line.usage;
    if (!u) return;
    // A session's first record fixes attribution even when that record is too old to be summed.
    const first = this.sessionFirst.get(u.sessionId);
    if (first === undefined || u.ts < first) this.sessionFirst.set(u.sessionId, u.ts);
    if (u.ts < minTs) return;

    const folder = folderNameFromProjectDir(t.projectDirName);
    const rec = this.records.get(u.messageId);
    if (!rec) {
      this.records.set(u.messageId, {
        ts: u.ts,
        s: u.sessionId,
        f: folder,
        m: u.model,
        u: [...u.usage],
      });
      return;
    }
    // The same message repeated (streaming lines, resumed or forked copies): each counter keeps its max, the
    // timestamp its min, and every session that carried it stays a candidate owner.
    rec.ts = Math.min(rec.ts, u.ts);
    for (let i = 0; i < 4; i++) rec.u[i] = Math.max(rec.u[i], u.usage[i]);
    if (folder < rec.f) rec.f = folder;
    if (u.sessionId !== rec.s && !rec.x?.includes(u.sessionId)) (rec.x ??= []).push(u.sessionId);
  }

  /** The newer announcement per window wins. Returns whether it replaced the stored one. */
  private ingestQuota(quota: QuotaSignal): boolean {
    const cur = this.quota[quota.window];
    if (cur && quota.ts <= cur.ts) return false;
    this.quota[quota.window] = { ts: quota.ts, resetsAt: quota.resetsAt };
    return true;
  }

  private prune(transcripts: readonly UsageTranscript[], now: number): void {
    const listed = new Set(transcripts.map((t) => t.path));
    const cutoff = now - TOKEN_LEDGER_WINDOW_MS;
    for (const p of this.files.keys()) if (!listed.has(p)) this.files.delete(p);
    for (const [id, rec] of this.records) if (rec.ts < cutoff) this.records.delete(id);
    const referenced = new Set<string>();
    for (const rec of this.records.values()) {
      referenced.add(rec.s);
      for (const x of rec.x ?? []) referenced.add(x);
    }
    for (const sid of this.sessionFirst.keys())
      if (!referenced.has(sid)) this.sessionFirst.delete(sid);
    // A title can precede its session's first usage record by a pass, and its bytes are then behind the offset for
    // good: keep titles of sessions whose transcript is still listed, not only those with a record.
    for (const t of transcripts) referenced.add(t.fallbackSessionId);
    for (const sid of this.titles.keys()) if (!referenced.has(sid)) this.titles.delete(sid);
  }

  private emitIfChanged(force: boolean): void {
    if (this.disposed) return;
    const message = this.snapshot();
    const { generatedAt: _generatedAt, ...stable } = message;
    const key = JSON.stringify(stable);
    if (!force && key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.options.onChange(message);
  }

  // ── Cache ────────────────────────────────────────────────

  private async loadCache(): Promise<void> {
    let parsed: Partial<CacheShape>;
    try {
      parsed = JSON.parse(
        await fs.promises.readFile(this.cachePath, 'utf8'),
      ) as Partial<CacheShape>;
    } catch {
      return; // absent or corrupt: cold scan
    }
    if (!parsed || parsed.version !== CACHE_VERSION || !parsed.files || !parsed.records) return;
    for (const [p, f] of Object.entries(parsed.files)) {
      if (
        f &&
        typeof f.offset === 'number' &&
        typeof f.size === 'number' &&
        typeof f.mtimeMs === 'number'
      ) {
        this.files.set(p, f);
      }
    }
    for (const [id, r] of Object.entries(parsed.records)) {
      if (
        r &&
        typeof r.ts === 'number' &&
        typeof r.s === 'string' &&
        typeof r.f === 'string' &&
        typeof r.m === 'string' &&
        isUsage4(r.u)
      ) {
        this.records.set(id, {
          ...r,
          ...(Array.isArray(r.x) && { x: r.x.filter((v) => typeof v === 'string') }),
        });
      }
    }
    for (const [sid, ts] of Object.entries(parsed.sessions ?? {})) {
      if (typeof ts === 'number') this.sessionFirst.set(sid, ts);
    }
    for (const [sid, t] of Object.entries(parsed.titles ?? {})) {
      if (t && typeof t === 'object') this.titles.set(sid, t);
    }
    // Merged, not assigned: the status line can anchor a window before this first pass, and its store reports a
    // reset time only once. The newer announcement per window wins, as everywhere else.
    const quota: unknown = parsed.quota;
    if (quota && typeof quota === 'object') {
      for (const window of QUOTA_WINDOWS) {
        const anchor = (quota as Record<string, unknown>)[window];
        if (isQuotaAnchor(anchor)) {
          this.ingestQuota({ window, ts: anchor.ts, resetsAt: anchor.resetsAt });
        }
      }
    }
  }

  private async flushCache(sync: boolean): Promise<void> {
    // Nothing new, or a half-read state not worth keeping.
    if (this.scanning || !this.dirty) return;
    const shape: CacheShape = {
      version: CACHE_VERSION,
      files: Object.fromEntries(this.files),
      records: Object.fromEntries(this.records),
      sessions: Object.fromEntries(this.sessionFirst),
      titles: Object.fromEntries(this.titles),
      quota: this.quota,
    };
    // pid-suffixed: VS Code and standalone can both be running and writing.
    const tmp = `${this.cachePath}.${process.pid}.tmp`;
    try {
      const json = JSON.stringify(shape);
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      if (sync) {
        fs.writeFileSync(tmp, json, 'utf8');
        fs.renameSync(tmp, this.cachePath);
      } else {
        await fs.promises.writeFile(tmp, json, 'utf8');
        await fs.promises.rename(tmp, this.cachePath);
      }
      this.dirty = false;
    } catch (err) {
      console.error('[pixelmates] Failed to write token ledger cache:', err);
    }
  }
}

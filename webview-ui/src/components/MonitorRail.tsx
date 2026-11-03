import { useLayoutEffect, useRef, useState } from 'react';

import type { UsageLimits } from '../../../core/src/messages.js';
import { MONITOR_CLOCK_TICK_MS, MONITOR_RING_HOT_PCT } from '../constants.js';
import type { MonitorSnapshot } from '../hooks/monitorVersion.js';
import { useNow } from '../hooks/useNow.js';
import { officeNow } from '../office/clock.js';
import type { OfficeState } from '../office/engine/officeState.js';
import {
  type Attention,
  contextPercent,
  minutesBlock,
  modelLabel,
  type Ticket,
} from './attention.js';
import { formatDuration } from './limitsPace.js';
import type { MonitorLayout } from './monitorLayout.js';
import { nextPaceCompact } from './paceCompact.js';
import { PacePanel } from './PacePanel.js';
import { CheckMark, Face, Medal, Ring } from './railArt.js';

export interface MonitorRailProps {
  officeState: OfficeState;
  monitor: MonitorSnapshot;
  layout: MonitorLayout;
  attention: Attention;
  limits: UsageLimits | null;
  statuslineInstalled: boolean;
  /** A ticket was clicked: select, follow and focus that agent. */
  onSelect: (id: number) => void;
  /** A ticket was double-clicked: select it and open the inspector on it. */
  onOpen: (id: number) => void;
}

/**
 * How tall the list's content is. `scrollHeight` is never under `clientHeight`, so it cannot say
 * how much room is spare; the last child's bottom edge can.
 */
function contentHeight(list: HTMLElement): number {
  const last = list.lastElementChild;
  if (!last) return Math.ceil(list.scrollHeight);
  const padBottom = parseFloat(getComputedStyle(list).paddingBottom) || 0;
  const bottom = last.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
  return Math.ceil(bottom + list.scrollTop + padBottom);
}

/** The face tile's inner box, CSS px, per rail mode: the tile minus its two borders. */
const FACE_BOX: Record<MonitorLayout['rail'], number> = { wide: 47, mid: 38, slim: 50 };

/** What a ticket shows about its agent beyond the reason: read straight off the stores. */
interface TicketView {
  ticket: Ticket;
  name: string;
  /** The name is the folder (no roster member yet): it masks like one. */
  nameIsFolder: boolean;
  palette: number;
  hueShift: number;
  tier?: number;
  pct?: number;
  model: string | null;
  /** The session's title, else its folder when the name is not already the folder; masked in privacy mode. */
  sub?: string;
  /** Branch, else folder; masked in privacy mode. */
  where?: string;
  age?: string;
}

function viewOf(os: OfficeState, ticket: Ticket, now: number): TicketView | null {
  const ch = os.characters.get(ticket.id);
  if (!ch) return null;
  const member = os.rosters.get(ticket.id)?.name || ch.agentName;
  const model = os.models.get(ticket.id);
  const meta = os.sessionMeta.get(ticket.id);
  const nameIsFolder = !member && !!ch.folderName;
  const sub =
    os.sessionTitles.get(ticket.id) || (nameIsFolder ? undefined : ch.folderName) || undefined;
  const where = meta?.branch || ch.folderName || undefined;
  return {
    ticket,
    name: member || ch.folderName || `Agent ${ticket.id}`,
    nameIsFolder,
    sub,
    palette: ch.palette,
    hueShift: ch.hueShift,
    tier: model?.tier,
    pct: contextPercent(ch.contextTokens, ch.maxContextTokens),
    model: modelLabel(model?.model, model?.tier),
    // The stub repeats nothing the title row already says.
    where: where === sub ? undefined : where,
    age: meta?.startedAt === undefined ? undefined : formatDuration(now - meta.startedAt),
  };
}

/** `Allow git push?` with the command boxed; a stuck reason's tail (` · no edits`) on its own line. */
function Reason({ ticket }: { ticket: Ticket }) {
  const allow = ticket.kind === 'permission' ? /^Allow (.+)\?$/.exec(ticket.reason) : null;
  if (allow) {
    return (
      <>
        Allow <span className="cmd">{allow[1]}</span>?
      </>
    );
  }
  const cut = ticket.reason.indexOf(' · ');
  if (ticket.kind === 'stuck' && cut > 0) {
    return (
      <>
        {ticket.reason.slice(0, cut)}
        <small>{ticket.reason.slice(cut + 3)}</small>
      </>
    );
  }
  return <>{ticket.reason}</>;
}

function Minutes({ ticket, now }: { ticket: Ticket; now: number }) {
  const block = minutesBlock(ticket.since, now);
  return (
    <div className={block.value.length > 2 ? 'tk-time long' : 'tk-time'}>
      <span>{block.value}</span>
      {block.unit && <span className="unit">{block.unit}</span>}
    </div>
  );
}

function FaceTile({
  view,
  box,
  medalScale,
}: {
  view: TicketView;
  box: number;
  medalScale: number;
}) {
  return (
    <div className="tk-face">
      <div className="pic">
        <Face palette={view.palette} hueShift={view.hueShift} boxCss={box} />
      </div>
      <span className="tk-icon">{view.ticket.glyph}</span>
      <span className="tk-md">
        <Medal tier={view.tier} pct={view.pct} scale={medalScale} />
      </span>
    </div>
  );
}

function FullTicket({
  view,
  now,
  box,
  medalScale,
  selected,
  onSelect,
  onOpen,
}: {
  view: TicketView;
  now: number;
  box: number;
  /** Medal size: art px per device-independent px (the wide rail draws it twice the size). */
  medalScale: number;
  selected: boolean;
  onSelect?: (id: number) => void;
  onOpen?: (id: number) => void;
}) {
  const { ticket } = view;
  const stuck = ticket.kind === 'stuck';
  const hot = view.pct !== undefined && view.pct >= MONITOR_RING_HOT_PCT;
  const right = [
    view.model && <span key="model">{view.model}</span>,
    view.pct !== undefined && (
      <span key="ctx" className="flex items-center gap-3">
        <Ring pct={view.pct} scale={1} />
        <b className={hot ? 'hot' : undefined}>{view.pct}%</b>
      </span>
    ),
    view.age && <span key="age">{view.age}</span>,
  ].filter(Boolean);
  const Tag = onSelect ? 'button' : 'div';
  return (
    <Tag
      {...(onSelect
        ? {
            type: 'button' as const,
            onClick: (e: React.MouseEvent<HTMLElement>) => {
              onSelect(ticket.id);
              // A mouse click leaves no focus behind, so Enter next opens the inspector.
              if (e.detail > 0) e.currentTarget.blur();
            },
            onDoubleClick: () => onOpen?.(ticket.id),
          }
        : {})}
      className={stuck ? 'tk stuck' : 'tk'}
      data-testid={onSelect ? 'monitor-ticket' : undefined}
      data-agent-id={ticket.id}
      data-kind={ticket.kind}
      data-selected={selected}
    >
      <FaceTile view={view} box={box} medalScale={medalScale} />
      <div className="tk-id">
        <div className="tk-name">
          <span className={view.nameIsFolder ? 'pv' : undefined} data-part="name">
            {view.name}
          </span>
        </div>
        {view.sub && (
          <div className="tk-sub pv" data-part="title">
            {view.sub}
          </div>
        )}
      </div>
      <div className="tk-why pv" data-part="reason">
        <Reason ticket={ticket} />
      </div>
      <Minutes ticket={ticket} now={now} />
      <div className="tk-stub">
        <span className="l">
          {view.where && (
            <span className="pv" data-part="where">
              {view.where}
            </span>
          )}
        </span>
        <span className="r">
          {right.flatMap((part, i) =>
            i === 0 ? [part] : [<span key={`dot${i}`}>{'·'}</span>, part],
          )}
        </span>
      </div>
    </Tag>
  );
}

function SlimTicket({
  view,
  now,
  selected,
  onSelect,
  onOpen,
  onHover,
}: {
  view: TicketView;
  now: number;
  selected: boolean;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
  onHover: (id: number | null, rect?: DOMRect) => void;
}) {
  const block = minutesBlock(view.ticket.since, now);
  return (
    <button
      type="button"
      className={view.ticket.kind === 'stuck' ? 'tk-slim stuck' : 'tk-slim'}
      data-testid="monitor-ticket"
      data-agent-id={view.ticket.id}
      data-kind={view.ticket.kind}
      data-selected={selected}
      aria-label={view.nameIsFolder ? 'Agent' : view.name}
      onClick={(e) => {
        onSelect(view.ticket.id);
        if (e.detail > 0) e.currentTarget.blur();
      }}
      onDoubleClick={() => onOpen(view.ticket.id)}
      onMouseEnter={(e) => onHover(view.ticket.id, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => onHover(null)}
    >
      <FaceTile view={view} box={FACE_BOX.slim} medalScale={1} />
      <span className="min">
        {block.value}
        {block.unit === 'MIN' ? 'm' : ''}
      </span>
    </button>
  );
}

type SectionTone = 'needs' | 'stuck' | 'yours';

const SECTION_TITLE: Record<SectionTone, string> = {
  needs: 'Needs you',
  stuck: 'Stuck',
  yours: 'Your turn',
};

function Section({
  tone,
  count,
  slim,
  children,
}: {
  tone: SectionTone;
  count: number;
  slim: boolean;
  children: React.ReactNode;
}) {
  const title = SECTION_TITLE[tone];
  return (
    <>
      <h2 className={tone === 'needs' ? 'att-h' : `att-h ${tone}`} title={slim ? title : undefined}>
        {!slim && <span>{title}</span>}
        <span className="cnt">{count}</span>
      </h2>
      {children}
    </>
  );
}

/** Nobody needs you and nobody is stuck: the time tile's twin, sage with a check, and no count. */
function AllClear({ slim }: { slim: boolean }) {
  return (
    <div className="att-clear" data-testid="rail-all-clear">
      <span className="tile">
        <CheckMark scale={slim ? 3 : 5} color="var(--mon-ink)" />
      </span>
      {!slim && <span className="txt">all clear</span>}
    </div>
  );
}

/**
 * The attention rail, left of the stage: who needs an answer, who is stuck, oldest first, and
 * the official limits' pace pinned below them. Clocks tick every 30 s (no frame loop); every
 * age is read off the office clock so the staged scene keeps its minutes.
 */
export function MonitorRail({
  officeState,
  layout,
  attention,
  limits,
  statuslineInstalled,
  onSelect,
  onOpen,
}: MonitorRailProps) {
  useNow(MONITOR_CLOCK_TICK_MS);
  const now = officeNow().getTime();
  const [hover, setHover] = useState<{ id: number; rect: DOMRect } | null>(null);
  const slim = layout.rail === 'slim';
  const railRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The panel's heights as last rendered full and compact: refs, since they only feed the next
  // decision. A full height gone stale (the panel gained or lost a row) costs one bounce.
  const fullH = useRef<number | null>(null);
  const compactH = useRef(0);
  const [listOverflows, setListOverflows] = useState(false);
  const [, setResizeTick] = useState(0);
  // The list's box moves with the window and with the panel above it: measure again then.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setResizeTick((n) => n + 1));
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  // After every render, deliberately without deps: the decision reads layout, not props. It sets
  // state only on a change, and a change settles in one more pass (see paceCompact.ts).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (slim) {
      // The slim rail forces compact; the first rail after it renders full and gets measured.
      fullH.current = null;
      if (listOverflows) setListOverflows(false);
      return;
    }
    const list = listRef.current;
    const rail = railRef.current;
    if (!list || !rail) return;
    const panel = rail.querySelector('[data-testid="pace-panel"]');
    // A panel that rendered nothing is 0 px tall: a measurement, not an unknown.
    const panelH = panel ? Math.ceil(panel.getBoundingClientRect().height) : 0;
    if (listOverflows) compactH.current = panelH;
    else fullH.current = panelH;
    const next = nextPaceCompact(listOverflows, {
      scrollH: contentHeight(list),
      clientH: list.clientHeight,
      fullH: fullH.current,
      compactH: compactH.current,
    });
    if (next !== listOverflows) setListOverflows(next);
  });
  const selected = officeState.selectedAgentId;
  const views = (tickets: Ticket[]) =>
    tickets.map((t) => viewOf(officeState, t, now)).filter((v): v is TicketView => v !== null);
  const needs = views(attention.needs);
  const stuck = views(attention.stuck);
  const yours = views(attention.yours);
  const render = (v: TicketView) =>
    slim ? (
      <SlimTicket
        key={v.ticket.id}
        view={v}
        now={now}
        selected={selected === v.ticket.id}
        onSelect={onSelect}
        onOpen={onOpen}
        onHover={(id, rect) => setHover(id === null || !rect ? null : { id, rect })}
      />
    ) : (
      <FullTicket
        key={v.ticket.id}
        view={v}
        now={now}
        box={FACE_BOX[layout.rail]}
        medalScale={layout.rail === 'wide' ? 2 : 1}
        selected={selected === v.ticket.id}
        onSelect={onSelect}
        onOpen={onOpen}
      />
    );
  const popView = hover
    ? [...needs, ...stuck, ...yours].find((v) => v.ticket.id === hover.id)
    : undefined;
  return (
    <aside
      ref={railRef}
      data-testid="monitor-rail"
      data-rail={layout.rail}
      className="mon-rail"
      style={{ width: layout.railPx }}
      aria-label="Attention"
    >
      <div ref={listRef} className="mon-list pixel-scrollbar">
        {/* A section with nobody in it is left out: absent, never 0. */}
        {needs.length > 0 && (
          <Section tone="needs" count={needs.length} slim={slim}>
            {needs.map(render)}
          </Section>
        )}
        {stuck.length > 0 && (
          <Section tone="stuck" count={stuck.length} slim={slim}>
            {stuck.map(render)}
          </Section>
        )}
        {/* Finished work is not an alarm: "all clear" still shows above it. */}
        {needs.length + stuck.length === 0 && <AllClear slim={slim} />}
        {yours.length > 0 && (
          <Section tone="yours" count={yours.length} slim={slim}>
            {yours.map(render)}
          </Section>
        )}
      </div>
      <PacePanel
        limits={limits}
        installed={statuslineInstalled}
        now={now}
        compact={slim || listOverflows}
      />
      {slim && popView && hover && (
        <div
          className="tk-pop"
          style={{
            left: hover.rect.right + 14,
            top: Math.max(8, Math.min(hover.rect.top, window.innerHeight - 180)),
          }}
        >
          <FullTicket view={popView} now={now} box={FACE_BOX.mid} medalScale={1} selected={false} />
        </div>
      )}
    </aside>
  );
}

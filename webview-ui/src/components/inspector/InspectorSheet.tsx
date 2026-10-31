import type { ReactNode } from 'react';

import type {
  ArtifactRow,
  Chip,
  InspectorView,
  Text,
  TreeGroup,
  VitalCell,
  WorkflowView,
} from './inspectorView.js';
import { ContextRing, Gem, PixelIcon } from './PixelArt.js';
import type { IconName } from './pixelBitmaps.js';

/** A run of text; session text carries `pv`, which privacy mode masks. */
function T({ t, className }: { t: Text; className?: string }) {
  const cls = [className, t.pv ? 'pv' : ''].filter(Boolean).join(' ');
  return <span className={cls || undefined}>{t.text}</span>;
}

function StateChip({ chip, testId }: { chip: Chip; testId?: string }) {
  return (
    <span className={`insp-chip insp-tone-${chip.tone}`} data-testid={testId}>
      {chip.mark === 'check' && <PixelIcon name="check" />}
      {chip.mark === 'loop' && <span className="insp-chip-mark">↻</span>}
      {chip.mark && chip.mark !== 'check' && chip.mark !== 'loop' && (
        <span className="insp-chip-mark">{chip.mark}</span>
      )}
      <span className="insp-chip-text">
        {chip.parts.map((p, k) => (
          <T key={k} t={p} />
        ))}
      </span>
    </span>
  );
}

function Heading({
  icon,
  glyph,
  children,
  aside,
}: {
  icon?: IconName;
  /** A font glyph in place of a pixel icon. */
  glyph?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <h3 className="insp-h">
      {icon && <PixelIcon name={icon} />}
      {glyph && <span className="insp-h-glyph">{glyph}</span>}
      <span>{children}</span>
      {aside}
    </h3>
  );
}

function Hero({ hero, portrait }: { hero: InspectorView['hero']; portrait: ReactNode }) {
  const metaIcon = { folder: 'folder', branch: 'branch' } as const;
  return (
    <section className="insp-hero" data-testid="inspector-hero">
      <div className="insp-hero-top">
        <div className="insp-portrait">
          <span className="insp-portrait-face">{portrait}</span>
          <span className="insp-br insp-br-1" />
          <span className="insp-br insp-br-2" />
          <span className="insp-br insp-br-3" />
          <span className="insp-br insp-br-4" />
        </div>
        <div className="insp-who">
          <div className="insp-name">
            <T t={hero.name} className="insp-name-text" />
            {hero.lead && <span className="insp-lead">LEAD</span>}
          </div>
          <StateChip chip={hero.chip} testId="inspector-state" />
        </div>
      </div>
      {hero.title && (
        <p className="insp-title">
          <T t={hero.title} />
        </p>
      )}
      {hero.question && (
        <p className="insp-question" data-testid="inspector-question">
          <T t={hero.question} />
        </p>
      )}
      {hero.meta.length > 0 && (
        <div className="insp-meta">
          {hero.meta.map((m) => (
            <span key={m.kind} className="insp-meta-item" data-testid={`inspector-${m.kind}`}>
              {m.kind === 'id' ? (
                <span className="insp-meta-hash">#</span>
              ) : (
                <PixelIcon name={metaIcon[m.kind]} />
              )}
              <T t={m.text} />
            </span>
          ))}
        </div>
      )}
      {hero.tags.length > 0 && (
        <div className="insp-tags">
          {hero.tags.map((t) => (
            <span key={t.kind} className={`insp-tag insp-tag-${t.kind}`}>
              {t.text}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function Parts({ parts }: { parts: Array<{ n: string; unit: string }> }) {
  return (
    <>
      {parts.map((p) => (
        <span key={p.unit} className="insp-num">
          {p.n}
          <small>{p.unit}</small>
        </span>
      ))}
    </>
  );
}

function Vital({ cell }: { cell: VitalCell }) {
  switch (cell.kind) {
    case 'context':
      return (
        <div className="insp-vital" data-testid="inspector-context">
          <span className="insp-k">Context</span>
          <span className={`insp-v${cell.tone === 'hot' ? ' insp-hot' : ''}`}>
            <ContextRing fraction={cell.fraction} tone={cell.tone} tier={cell.tier} />
            <span className="insp-num">
              {cell.pct}
              <small>%</small>
            </span>
          </span>
          <span className="insp-cap">{cell.caption}</span>
        </div>
      );
    case 'model':
      return (
        <div className="insp-vital" data-testid="inspector-model">
          <span className="insp-k">Model</span>
          <span className="insp-v insp-v-model">
            {cell.tier !== undefined && <Gem tier={cell.tier} />}
            <span className="insp-ellipsis">{cell.text}</span>
          </span>
          {cell.caption && <span className="insp-cap">{cell.caption}</span>}
        </div>
      );
    case 'session':
      return (
        <div className="insp-vital" data-testid="inspector-session">
          <span className="insp-k">Session</span>
          <span className="insp-v">
            <PixelIcon name="hourglass" />
            <Parts parts={cell.parts} />
          </span>
          <span className="insp-cap">{cell.caption}</span>
        </div>
      );
    case 'cost':
      return (
        <div className="insp-vital" data-testid="inspector-cost">
          <span className="insp-k">Cost</span>
          <span className="insp-v">
            <PixelIcon name="coin" />
            <span className="insp-num">{cell.text}</span>
          </span>
          {cell.caption && <span className="insp-cap">{cell.caption}</span>}
        </div>
      );
    case 'cache':
      return (
        <div className="insp-vital" data-testid="inspector-cache">
          <span className="insp-k">Cache</span>
          <span className={`insp-v${cell.cold ? ' insp-hot' : ''}`}>
            <PixelIcon name={cell.cold ? 'candleCold' : 'candle'} />
            {cell.cold ? <span className="insp-num">cold</span> : <Parts parts={cell.parts} />}
          </span>
          <span className="insp-cap">{cell.caption}</span>
        </div>
      );
  }
}

function Workflow({ run }: { run: WorkflowView }) {
  return (
    <div className="insp-wf">
      <div className="insp-wf-name">
        <T t={run.name} className="insp-wf-title" />
        {run.done ? (
          <span className="insp-chip insp-tone-sage">
            <PixelIcon name="check" />
            <span className="insp-chip-text">done</span>
          </span>
        ) : (
          run.age && <span className="insp-cap">{run.age}</span>
        )}
      </div>
      {run.phases.length > 0 && (
        <div className="insp-phases">
          {run.phases.map((p, k) => (
            <span key={`${k}-${p.name}`} className="insp-phase-wrap">
              {k > 0 && <span className="insp-phase-sep">›</span>}
              <span className={`insp-phase${p.current ? ' insp-phase-now' : ''}`}>
                <span>{p.name}</span>
                <span className="insp-pips" aria-label={`${p.done} of ${p.started} done`}>
                  {Array.from({ length: p.started }, (_, n) => (
                    <i key={n} className={n < p.done ? 'on' : undefined} />
                  ))}
                </span>
              </span>
            </span>
          ))}
        </div>
      )}
      {run.counts && <div className="insp-wf-counts">{run.counts}</div>}
    </div>
  );
}

function Tree({ name, groups }: { name: Text; groups: TreeGroup[] }) {
  return (
    <div className="insp-tree">
      <div className="insp-tree-root">
        <span className="insp-tree-dot" />
        <T t={name} className="insp-tree-name" />
      </div>
      {groups.map((g) => (
        <div key={g.kind + (g.name?.text ?? '')} className={`insp-tree-g insp-tree-${g.kind}`}>
          <div className="insp-tree-gl">
            <span className="insp-k">{g.title}</span>
            {g.name && <T t={g.name} className="insp-tree-gname" />}
          </div>
          <ul className="insp-tree-rows">
            {g.rows.map((r) => (
              <li key={r.key}>
                <span className="insp-tree-lbl">
                  <T t={r.name} />
                  {(r.sub || r.minutes) && (
                    <small>{[r.sub, r.minutes].filter(Boolean).join(' · ')}</small>
                  )}
                </span>
                <StateChip chip={r.chip} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Artifact({ row }: { row: ArtifactRow }) {
  return (
    <li className="insp-art">
      <span className="insp-art-ic">
        <PixelIcon name="page" />
      </span>
      <span className="insp-art-body">
        <span className="insp-art-title">
          <T t={row.title} className="insp-ellipsis" />
        </span>
        <span className="insp-art-sub">
          {row.publishes && <span className="insp-kd">{row.publishes}</span>}
          {row.urlText &&
            (row.href ? (
              <a
                className="insp-link"
                href={row.href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="inspector-artifact-link"
              >
                <T t={row.urlText} className="insp-ellipsis" />
                <span className="insp-link-arrow">↗</span>
              </a>
            ) : (
              <T t={row.urlText} className="insp-ellipsis insp-cap" />
            ))}
        </span>
      </span>
      {row.time && <span className="insp-art-time">{row.time}</span>}
    </li>
  );
}

export interface InspectorSheetProps {
  view: InspectorView;
  /** The agent's face (W1's rail face), absent in a server render. */
  portrait: ReactNode;
  onClose: () => void;
  onAckTripwire: (id: number, count: number) => void;
}

/** One agent's sheet: lays out the view, each section only when it has something to say. */
export function InspectorSheet({ view, portrait, onClose, onAckTripwire }: InspectorSheetProps) {
  const { hero, vitals, now, workflows, loop, tree, artifacts, tests, health, tripwire } = view;
  return (
    <div className="insp-paper pixel-scrollbar" data-agent-id={view.id}>
      <button
        type="button"
        className="insp-close"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close the inspector"
        data-testid="inspector-close"
      >
        <span className="insp-close-x" aria-hidden="true">
          ×
        </span>
        <span className="insp-close-key" aria-hidden="true">
          Esc
        </span>
      </button>

      <Hero hero={hero} portrait={portrait} />

      {tripwire && (
        <button
          type="button"
          className={`insp-alert insp-alert-trip insp-sev-${tripwire.severity}`}
          onClick={() => onAckTripwire(view.id, tripwire.count)}
          title="Acknowledge"
          data-testid="inspector-tripwire"
        >
          <PixelIcon name="warn" />
          <span className="insp-alert-text">
            <b>{tripwire.ruleName}</b>
            {tripwire.countText && <span className="insp-alert-count">{tripwire.countText}</span>}
          </span>
          <span className="insp-keycap insp-keycap-ack">ack</span>
        </button>
      )}
      {health && (
        <div className="insp-alert insp-alert-health" data-testid="inspector-health">
          <PixelIcon name="pulse" />
          <span className="insp-alert-text">
            <b>{health.state}</b> {health.label}
          </span>
          {health.since && <span className="insp-alert-since">{health.since}</span>}
        </div>
      )}

      {vitals.length > 0 && (
        <section className="insp-vitals" data-testid="inspector-vitals">
          {vitals.map((cell) => (
            <Vital key={cell.kind} cell={cell} />
          ))}
        </section>
      )}
      {view.coldNote && <p className="insp-cold-note">{view.coldNote}</p>}

      {now && (
        <section className="insp-sec" data-testid="inspector-now">
          <div className={`insp-term${now.waiting ? ' insp-term-wait' : ''}`}>
            <span className="insp-term-k">Now</span>
            <span className="insp-term-c">
              {now.command && <span className="insp-term-prompt">›</span>}
              <T t={now.text} className="insp-ellipsis" />
              <i className="insp-cursor" />
            </span>
            {now.since && <span className="insp-term-t">{now.since}</span>}
          </div>
        </section>
      )}

      {workflows.length > 0 && (
        <section className="insp-sec" data-testid="inspector-workflow">
          <Heading icon="flask">Workflow</Heading>
          {workflows.map((run) => (
            <Workflow key={run.key} run={run} />
          ))}
        </section>
      )}

      {loop && (
        <section className="insp-sec" data-testid="inspector-loop">
          <Heading glyph="↻">Loop</Heading>
          <div className="insp-loop">
            {loop.next && <span className="insp-loop-next">{loop.next}</span>}
            {loop.wakes && <span className="insp-kd">{loop.wakes}</span>}
          </div>
        </section>
      )}

      {tree.length > 0 && (
        <section className="insp-sec" data-testid="inspector-tree">
          <Heading>Depends on whom</Heading>
          <Tree name={hero.name} groups={tree} />
        </section>
      )}

      {artifacts && (
        <section className="insp-sec" data-testid="inspector-artifacts">
          <Heading icon="page" aside={<span className="insp-count">{artifacts.count}</span>}>
            Artifacts
          </Heading>
          <ul className="insp-arts">
            {artifacts.rows.map((row) => (
              <Artifact key={row.key} row={row} />
            ))}
          </ul>
        </section>
      )}

      {tests && (
        <section className="insp-sec" data-testid="inspector-tests">
          <Heading icon="check">Tests</Heading>
          <div className="insp-tests">
            {tests.passed !== undefined && (
              <span className="insp-pass">
                <i className="insp-sq" />
                {tests.passed} passed
              </span>
            )}
            {tests.failed !== undefined && (
              <span className={tests.failed > 0 ? 'insp-fail' : 'insp-pass'}>
                <i className="insp-sq" />
                {tests.failed} failed
              </span>
            )}
            {tests.at && <span className="insp-cap">at {tests.at}</span>}
          </div>
        </section>
      )}
    </div>
  );
}

import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';

import type { UsageLimits } from '../../../core/src/messages.js';
import { useMonitorVersion } from '../hooks/useMonitorVersion.js';
import { useTabBadge } from '../hooks/useTabBadge.js';
import { requestRedraw } from '../office/engine/gameLoop.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { setMonitorFullPlates } from '../office/nameplate.js';
import type { ToolActivity } from '../office/types.js';
import { badgeCount } from '../tabBadge.js';
import { attentionOf } from './attentionSource.js';
import { monitorLayout } from './monitorLayout.js';
import { MonitorRail } from './MonitorRail.js';
import { type InspectorWiring, MonitorSheet } from './MonitorSheet.js';

function windowLayout() {
  return monitorLayout(window.innerWidth, window.innerHeight);
}

export interface MonitorShellProps {
  officeState: OfficeState;
  /** The hook's React mirrors the rail reads beside OfficeState. */
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  limits: UsageLimits | null;
  statuslineInstalled: boolean;
  privacy: boolean;
  onSelect: (id: number) => void;
  /** A ticket was double-clicked: select it and open the inspector. */
  onOpen: (id: number) => void;
  /** The App's tool rows and actions the inspector sheet reads. */
  inspector: InspectorWiring;
  children: ReactNode;
}

/**
 * The window's row: [rail][stage][sheet]. The stage (`children`, the office and everything
 * positioned on it) is the flexible middle column, so a rail or sheet that takes width shrinks
 * it and the canvas re-fits through its own ResizeObserver.
 *
 * The one reader of the monitor version: a store write re-renders this row, and the stage passed
 * in as `children` is the same element, so React skips it. Privacy mode is a class here, so every
 * `.pv` text below it (rail, plates, sheet) masks at once.
 */
export function MonitorShell({
  officeState,
  agentTools,
  agentStatuses,
  limits,
  statuslineInstalled,
  privacy,
  onSelect,
  onOpen,
  inspector,
  children,
}: MonitorShellProps) {
  const monitor = useMonitorVersion(officeState);
  const [layout, setLayout] = useState(windowLayout);
  useEffect(() => {
    const onResize = (): void => setLayout(windowLayout());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Beside a full rail the plates keep their second line at every zoom (the canvas overlay
  // reads the flag on its next frame).
  useEffect(() => {
    setMonitorFullPlates(layout.fullPlates);
    requestRedraw();
  }, [layout.fullPlates]);
  // Landing on another agent with the sheet open counts as opening it. Status and `since` stay
  // out of the deps: a turn that ends under an already-open sheet had no gesture.
  const sheetOpen = officeState.monitorSheetOpen;
  const selectedAgentId = officeState.selectedAgentId;
  useEffect(() => {
    if (!sheetOpen) return;
    officeState.markSeenIfYourTurn(selectedAgentId);
    // The mark bumps the version outside a host message; the panels re-render after a drawn frame.
    requestRedraw();
  }, [officeState, sheetOpen, selectedAgentId]);
  const attention = attentionOf(officeState, agentTools, agentStatuses);
  useTabBadge(badgeCount(attention));
  return (
    <div
      // Relative: below 1600 px the sheet overlays the stage, positioned on this row.
      className={`mon-row relative w-full h-full flex overflow-hidden${privacy ? ' mon-privacy' : ''}`}
      data-privacy={privacy ? 'on' : 'off'}
      // The overlay sheet's width, for what on the stage must stay clear of it (the bottom bar).
      style={{ '--mon-sheet-px': `${layout.sheetPx}px` } as CSSProperties}
    >
      <MonitorRail
        officeState={officeState}
        monitor={monitor}
        layout={layout}
        attention={attention}
        limits={limits}
        statuslineInstalled={statuslineInstalled}
        onSelect={onSelect}
        onOpen={onOpen}
      />
      {children}
      <MonitorSheet
        officeState={officeState}
        monitor={monitor}
        layout={layout}
        inspector={inspector}
      />
    </div>
  );
}

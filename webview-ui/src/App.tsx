import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toMajorMinor } from './changelogData.js';
import { cycleOrder } from './components/attention.js';
import { attentionOf, sessionIds } from './components/attentionSource.js';
import { BottomToolbar } from './components/BottomToolbar.js';
import { ChangelogModal } from './components/ChangelogModal.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { DebugView } from './components/DebugView.js';
import { EditActionBar } from './components/EditActionBar.js';
import { HudCard } from './components/HudCard.js';
import { closeSheet } from './components/inspector/sheetControl.js';
import { IntroBubble } from './components/IntroBubble.js';
import { LightingTint } from './components/LightingTint.js';
import { MigrationNotice } from './components/MigrationNotice.js';
import { monitorLayout } from './components/monitorLayout.js';
import { MonitorShell } from './components/MonitorShell.js';
import { SettingsModal } from './components/SettingsModal.js';
import { StageClock } from './components/StageClock.js';
import { Tooltip } from './components/Tooltip.js';
import { Modal } from './components/ui/Modal.js';
import { UsagePanel } from './components/UsagePanel.js';
import { VersionIndicator } from './components/VersionIndicator.js';
import { CLAUDE_HOOKS_PROVIDER_ID, CLAUDE_STATUSLINE_PROVIDER_ID } from './constants.js';
import { isEditDirty, noteLayoutSent } from './hooks/layoutLoadedGate.js';
import { usePrivacy } from './hooks/monitorPrivacy.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js';
import { useExtensionMessages } from './hooks/useExtensionMessages.js';
import { useIntroTour } from './hooks/useIntroTour.js';
import { useMonitorKeys } from './hooks/useMonitorKeys.js';
import { AutoFit } from './office/camera.js';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { editorState } from './office/editor/editorState.js';
import { EditorToolbar } from './office/editor/EditorToolbar.js';
import { requestRedraw } from './office/engine/gameLoop.js';
import { OfficeState } from './office/engine/officeState.js';
import { exportLayoutToFile } from './office/layout/exportLayout.js';
import { isRotatable } from './office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from './office/layout/layoutSerializer.js';
import { getPetCount } from './office/sprites/petSpriteData.js';
import { EditTool, type OfficeLayout } from './office/types.js';
import { isBrowserRuntime, isE2E } from './runtime.js';
import { installTestHooks } from './testHooks.js';
import { transport } from './transport/index.js';

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null };

// Test-only observability hooks (message/sound logs, addAgent wrapper, selectAgent).
// Installed only under the e2e harness so they never patch prototypes or grow
// unbounded logs in a real user's session.
if (isE2E) installTestHooks(officeStateRef);

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

function App() {
  const editor = useEditorActions(getOfficeState, editorState);

  // Fit to activity: on at start, off after any manual zoom or pan, back on with the Fit button.
  const [fitActive, setFitActive] = useState(true);
  const [autoFit] = useState(() => new AutoFit(setFitActive));
  const { handleZoomChange } = editor;
  const handleManualZoom = useCallback(
    (z: number) => {
      autoFit.disable();
      handleZoomChange(z);
    },
    [autoFit, handleZoomChange],
  );
  const handleFit = useCallback(() => {
    // A follow would take the camera straight back on the next frame.
    getOfficeState().cameraFollowId = null;
    autoFit.enable();
    // The fit lands on the next drawn frame, which a quiet office would only draw a second later.
    requestRedraw();
  }, [autoFit]);

  // Browser runtime (dev or static dist): dispatch mock messages after the
  // useExtensionMessages listener has been registered.
  useEffect(() => {
    // browserMock is for Vite dev mode only (UI prototyping without a server).
    // In standalone server mode, the server sends all state over WebSocket.
    // In VS Code mode, the extension sends all state via postMessage.
    if (isBrowserRuntime && import.meta.env.DEV) {
      void import('./browserMock.js').then(({ dispatchMockMessages }) =>
        dispatchMockMessages({
          office: getOfficeState(),
          setZoom: (z) => {
            autoFit.disable();
            handleZoomChange(z);
          },
          roomLayout: () => getOfficeState().getLayout(),
          setPan: (pan) => {
            editor.panRef.current = pan;
            requestRedraw();
          },
        }),
      );
    }
    // Once on mount: autoFit and handleZoomChange are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    workspaceFolders,
    agentFolderNames,
    externalAssetDirectories,
    lastSeenVersion,
    extensionVersion,
    watchAllSessions,
    setWatchAllSessions,
    ghostHeadlessAgents,
    setGhostHeadlessAgents,
    showModelFlair,
    setShowModelFlair,
    cozyLighting,
    setCozyLighting,
    hooksEnabled,
    hooksInstalled,
    hooksStatusSeq,
    hooksInfoShown,
    consentRequest,
    dismissConsentRequest,
    areaMappings,
    setAreaMappings,
    showAreas,
    setShowAreas,
    tokenUsage,
    usageLimits,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout);

  // Show migration notice once layout reset is detected
  const [migrationNoticeDismissed, setMigrationNoticeDismissed] = useState(false);
  const showMigrationNotice = layoutWasReset && !migrationNoticeDismissed;

  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isUsageOpen, setIsUsageOpen] = useState(false);
  const [isHooksInfoOpen, setIsHooksInfoOpen] = useState(false);
  const [hooksTooltipDismissed, setHooksTooltipDismissed] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);

  const currentMajorMinor = toMajorMinor(extensionVersion);

  const handleWhatsNewDismiss = useCallback(() => {
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  const handleOpenChangelog = useCallback(() => {
    setIsChangelogOpen(true);
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), []);

  // Toggle "Display headless as ghosts". setGhostHeadlessAgents also updates the
  // renderer's module copy, so the office redraws on the next frame.
  const handleToggleGhostHeadlessAgents = useCallback(() => {
    const next = !ghostHeadlessAgents;
    setGhostHeadlessAgents(next);
    transport.send({ type: 'setGhostHeadlessAgents', enabled: next });
  }, [ghostHeadlessAgents, setGhostHeadlessAgents]);

  // Toggle the model look. setShowModelFlair also updates the renderer's module copy.
  const handleToggleShowModelFlair = useCallback(() => {
    const next = !showModelFlair;
    setShowModelFlair(next);
    transport.send({ type: 'setShowModelFlair', enabled: next });
  }, [showModelFlair, setShowModelFlair]);

  // Toggle the lighting pass. setCozyLighting also updates the renderer's module copy (glows).
  const handleToggleCozyLighting = useCallback(() => {
    const next = !cozyLighting;
    setCozyLighting(next);
    transport.send({ type: 'setCozyLighting', enabled: next });
  }, [cozyLighting, setCozyLighting]);

  const handleSelectAgent = useCallback((id: number) => {
    transport.send({ type: 'focusAgent', id });
  }, []);

  // The Intro's wire-facing state machine — which asks survive being mooted,
  // when a hooksStatus is this tour's install verdict — lives in useIntroTour
  // (pure reducer in introTourState.ts); the App only wires it to the bubble.
  const {
    intro,
    installFailed,
    installPending,
    onChoice: handleConsentChoice,
    onClose: handleIntroClose,
  } = useIntroTour({ consentRequest, hooksInstalled, hooksStatusSeq, dismissConsentRequest });

  // The hooks tooltip is about the Claude hooks row of the per-provider install-state map.
  const claudeHooksInstalled = hooksInstalled[CLAUDE_HOOKS_PROVIDER_ID] === true;
  // Official limits show only while the status line wrapper is installed.
  const statuslineInstalled = hooksInstalled[CLAUDE_STATUSLINE_PROVIDER_ID] === true;

  // A Settings toggle-on whose ask was never answered comes back as a consent ask, which the Intro renders under the
  // Settings modal's backdrop: close Settings when the ask for the provider just toggled arrives, so the toggle
  // visibly leads somewhere.
  const askedFromSettingsRef = useRef<string | null>(null);
  useEffect(() => {
    if (consentRequest && consentRequest.providerId === askedFromSettingsRef.current) {
      askedFromSettingsRef.current = null;
      setIsSettingsOpen(false);
    }
  }, [consentRequest]);
  // A toggle the server answered with a status instead (the ask was already answered, so it installed directly) asked
  // nothing: forget it, or a later unrelated ask for that provider would close Settings.
  const statusSeqAtToggleRef = useRef(hooksStatusSeq);
  useEffect(() => {
    const providerId = askedFromSettingsRef.current;
    if (
      providerId !== null &&
      hooksStatusSeq[providerId] !== statusSeqAtToggleRef.current[providerId]
    ) {
      askedFromSettingsRef.current = null;
    }
    statusSeqAtToggleRef.current = hooksStatusSeq;
  }, [hooksStatusSeq]);

  // Toggle the DISPLAYED state (actual install), not the preference: when the two disagree (preference on, nothing
  // installed while consent is pending), toggling the preference would turn hooks OFF for a user asking for ON. No
  // optimistic local update either; both backends answer with the truthful hooksStatus the checkbox renders (or with
  // the consent ask first), so it lands correct instead of flickering when an install fails. The providerId is
  // ECHOED from that provider's row (never originated here), so nothing sends until the row has arrived.
  const handleToggleHooks = useCallback(
    (providerId: string) => {
      const row = Object.entries(hooksInstalled).find(([id]) => id === providerId);
      if (row === undefined) return;
      const [rowProviderId, installed] = row;
      if (!installed) askedFromSettingsRef.current = rowProviderId;
      transport.send({ type: 'setHooksEnabled', providerId: rowProviderId, enabled: !installed });
    },
    [hooksInstalled],
  );

  // Mutate folder→Area mappings locally + send to server. Updates OfficeState in
  // the same tick so a follow-up agentCreated picks up the new mapping.
  const handleAreaMappingChange = useCallback(
    (folderName: string, areaLabel: string, action: 'add' | 'remove') => {
      const current = areaMappings[folderName] ?? [];
      let nextLabels: string[];
      if (action === 'add') {
        if (current.includes(areaLabel)) return;
        nextLabels = [...current, areaLabel];
      } else {
        nextLabels = current.filter((l) => l !== areaLabel);
      }
      const next = { ...areaMappings };
      if (nextLabels.length === 0) {
        delete next[folderName];
      } else {
        next[folderName] = nextLabels;
      }
      setAreaMappings(next);
      getOfficeState().setAreaMappings(next);
      transport.send({ type: 'saveAreaMappings', mappings: next });
    },
    [areaMappings, setAreaMappings],
  );

  // Toggle global Show Areas — persisted via setShowAreas message; runs server-
  // side through configPersistence.
  const onToggleShowAreas = useCallback(() => {
    const next = !showAreas;
    setShowAreas(next);
    transport.send({ type: 'setShowAreas', enabled: next });
  }, [showAreas, setShowAreas]);

  // The Area color wash is drawn only while the Areas tool is active, so someone painting
  // sees what they are editing; Show Areas controls the room signs alone. The selected
  // area's wash is alpha-bumped via activeAreaLabel.
  const isEditingAreas = editor.isEditMode && editorState.activeTool === EditTool.AREA_PAINT;
  const activeAreaLabel = isEditingAreas ? editor.selectedAreaLabel : null;

  // e2e: register the component-scoped editor-action drivers + the effective
  // show-areas gate on the test-hooks namespace (module-load installTestHooks
  // can't reach these React callbacks). Bypasses only canvas pixel→tile
  // geometry — the handlers still own undo/dirty/rebuild. Guarded on isE2E.
  useEffect(() => {
    if (!isE2E || typeof window === 'undefined') return;
    const hooks = (window.__pixelAgentsTestHooks ??= {});
    hooks.editorTileAction = (col, row) => editor.handleEditorTileAction(col, row);
    hooks.editorEraseAction = (col, row) => editor.handleEditorEraseAction(col, row);
    // Room signs show with the setting or while editing areas.
    hooks.getShowAreas = () => isEditingAreas || showAreas;
  }, [editor.handleEditorTileAction, editor.handleEditorEraseAction, isEditingAreas, showAreas]);

  const containerRef = useRef<HTMLDivElement>(null);

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0);
  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  );

  const handleCloseAgent = useCallback((id: number) => {
    transport.send({ type: 'closeAgent', id });
  }, []);

  const handleAckTripwire = useCallback((id: number, count: number) => {
    transport.send({ type: 'ackTripwire', id, count });
  }, []);

  // The inspector sheet and the Usage panel share the right edge: opening the sheet closes it.
  const handleInspectorOpen = useCallback(() => setIsUsageOpen(false), []);
  // Opening or closing the sheet re-frames the office in the width it leaves: beside it from
  // 1600 px (the stage narrows), in front of it below (the sheet covers `insetPx` of the stage).
  // Open, the fit keeps the office's zoom (AutoFit.setSheet); closed, it frames as before. It
  // takes the camera back from a follow or a manual view, which would otherwise keep the office
  // cut by the sheet or squeezed to its old width.
  const sheetLayoutRef = useRef({ open: false, insetPx: 0 });
  const handleSheetLayout = useCallback(
    (open: boolean, insetPx: number) => {
      const prev = sheetLayoutRef.current;
      if (prev.open === open && prev.insetPx === insetPx) return;
      autoFit.setSheet(open, insetPx);
      sheetLayoutRef.current = { open, insetPx };
      getOfficeState().cameraFollowId = null;
      autoFit.enable();
      requestRedraw();
    },
    [autoFit],
  );

  const handleClick = useCallback((agentId: number) => {
    // If clicked agent is a sub-agent, focus the parent's terminal instead
    const os = getOfficeState();
    const meta = os.subagentMeta.get(agentId);
    const focusId = meta ? meta.parentAgentId : agentId;
    transport.send({ type: 'focusAgent', id: focusId });
  }, []);

  // The monitor's selection: what a canvas click does to an agent, without the toggle.
  const selectAndFollow = useCallback((id: number) => {
    const os = getOfficeState();
    os.selectedAgentId = id;
    os.cameraFollowId = id;
    requestRedraw();
  }, []);
  const handleRailSelect = useCallback(
    (id: number) => {
      selectAndFollow(id);
      handleClick(id);
    },
    [selectAndFollow, handleClick],
  );

  const [privacy, togglePrivacy] = usePrivacy();
  // Read at the key press, so the order is the rail's as it stands then.
  const toolsRef = useRef(agentTools);
  toolsRef.current = agentTools;
  const statusesRef = useRef(agentStatuses);
  statusesRef.current = agentStatuses;
  useMonitorKeys(getOfficeState(), {
    blocked:
      editor.isEditMode ||
      !!intro ||
      isSettingsOpen ||
      isChangelogOpen ||
      isHooksInfoOpen ||
      showMigrationNotice,
    order: () => {
      const os = getOfficeState();
      return cycleOrder(attentionOf(os, toolsRef.current, statusesRef.current), sessionIds(os));
    },
    select: selectAndFollow,
    togglePrivacy,
    // The sheet takes the Usage panel's corner.
    onSheetOpen: handleInspectorOpen,
  });

  const officeState = getOfficeState();

  // Merged set of folders the Areas dropdown can map: real workspace folders plus
  // every distinct folder an agent has run in this session (deduped by name; name
  // is the areaMappings key / seat-bias identity, path is only the React list key).
  const areaFolders = useMemo(() => {
    const byName = new Map<string, { name: string; path: string }>();
    for (const f of workspaceFolders) byName.set(f.name, f);
    for (const name of agentFolderNames) {
      if (!byName.has(name)) byName.set(name, { name, path: name });
    }
    return [...byName.values()];
  }, [workspaceFolders, agentFolderNames]);

  // Areas authoring is available when the layout already defines areas, or when
  // there is at least one mappable folder. Decouples the Areas UI from VS Code
  // multi-root workspaces (fixes single-root VS Code AND standalone, where
  // workspaceFolders is always empty).
  const areasAvailable = (officeState.getLayout().areas?.length ?? 0) > 0 || areaFolders.length > 0;

  const handleExportLayout = useCallback(() => {
    exportLayoutToFile(getOfficeState().getLayout());
  }, []);

  const handleImportLayout = useCallback(
    (file: File) => {
      // Browser-native import (standalone): read + validate + apply directly,
      // bypassing the layoutLoaded message whose dirty guard would skip it.
      if (
        isEditDirty() &&
        !window.confirm('Replace the current layout? Unsaved edits will be lost.')
      ) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(String(reader.result)) as Record<string, unknown>;
          // Match the VS Code guard, plus the furniture-array check VS Code omits
          // (migrate + rebuild iterate furniture and would throw on a non-array).
          if (
            imported.version !== 1 ||
            !Array.isArray(imported.tiles) ||
            !Array.isArray(imported.furniture)
          ) {
            window.alert('Invalid layout file.');
            return;
          }
          const migrated = migrateLayoutColors(imported as unknown as OfficeLayout);
          getOfficeState().rebuildFromLayout(migrated);
          editor.setLastSavedLayout(migrated);
          noteLayoutSent(migrated);
          transport.send({
            type: 'saveLayout',
            layout: migrated as unknown as Record<string, unknown>,
          });
          editor.markClean();
        } catch {
          window.alert('Failed to read or parse layout file.');
        }
      };
      reader.readAsText(file);
    },
    [editor],
  );

  // Force dependency on editorTickForKeyboard to propagate keyboard-triggered re-renders
  void editorTickForKeyboard;

  // Show "Press R to rotate" hint when a rotatable item is selected or being placed
  const showRotateHint =
    editor.isEditMode &&
    (() => {
      if (editorState.selectedFurnitureUid) {
        const item = officeState
          .getLayout()
          .furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
        if (item && isRotatable(item.type)) return true;
      }
      if (
        editorState.activeTool === EditTool.FURNITURE_PLACE &&
        isRotatable(editorState.selectedFurnitureType)
      ) {
        return true;
      }
      return false;
    })();

  if (!layoutReady) {
    return <div className="w-full h-full flex items-center justify-center ">Loading...</div>;
  }

  // The stage: the middle column of the monitor's row. Every position on the office derives
  // from this box, so the canvas and its overlays stay inside it.
  const stage = (
    <div ref={containerRef} className="relative flex-1 min-w-0 h-full overflow-hidden">
      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        isEditMode={editor.isEditMode}
        editorState={editorState}
        onEditorTileAction={editor.handleEditorTileAction}
        onEditorEraseAction={editor.handleEditorEraseAction}
        onEditorSelectionChange={editor.handleEditorSelectionChange}
        onDeleteSelected={editor.handleDeleteSelected}
        onRotateSelected={editor.handleRotateSelected}
        onDragMove={editor.handleDragMove}
        editorTick={editor.editorTick}
        zoom={editor.zoom}
        onZoomChange={handleManualZoom}
        autoFit={autoFit}
        onAutoZoom={handleZoomChange}
        panRef={editor.panRef}
        showAreas={showAreas || isEditingAreas}
        isEditingAreas={isEditingAreas}
        activeAreaLabel={activeAreaLabel}
      />

      {!isDebugMode ? (
        <>
          {cozyLighting && (
            <LightingTint
              officeState={officeState}
              containerRef={containerRef}
              zoom={editor.zoom}
              panRef={editor.panRef}
            />
          )}

          <StageClock characters={officeState.characters} />

          {/* Vignette overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ background: 'var(--vignette)' }}
          />

          {editor.isEditMode && editor.isDirty && (
            <EditActionBar editor={editor} editorState={editorState} />
          )}

          {showRotateHint && (
            <div
              className="absolute left-1/2 -translate-x-1/2 z-11 bg-accent-bright text-white text-sm py-3 px-8 rounded-none border-2 border-accent shadow-pixel pointer-events-none whitespace-nowrap"
              style={{ top: editor.isDirty ? 64 : 8 }}
            >
              Rotate (R)
            </div>
          )}

          {editor.isEditMode &&
            (() => {
              const selUid = editorState.selectedFurnitureUid;
              const selColor = selUid
                ? (officeState.getLayout().furniture.find((f) => f.uid === selUid)?.color ?? null)
                : null;
              return (
                <EditorToolbar
                  activeTool={editorState.activeTool}
                  selectedTileType={editorState.selectedTileType}
                  selectedFurnitureType={editorState.selectedFurnitureType}
                  selectedFurnitureUid={selUid}
                  selectedFurnitureColor={selColor}
                  floorColor={editorState.floorColor}
                  wallColor={editorState.wallColor}
                  selectedWallSet={editorState.selectedWallSet}
                  onToolChange={editor.handleToolChange}
                  onTileTypeChange={editor.handleTileTypeChange}
                  onFloorColorChange={editor.handleFloorColorChange}
                  onWallColorChange={editor.handleWallColorChange}
                  onWallSetChange={editor.handleWallSetChange}
                  onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
                  pickedFurnitureColor={editorState.pickedFurnitureColor}
                  onPickedFurnitureColorChange={editor.handlePickedFurnitureColorChange}
                  onFurnitureTypeChange={editor.handleFurnitureTypeChange}
                  loadedAssets={loadedAssets}
                  activePetTypes={officeState.getActivePetTypes()}
                  petCount={getPetCount()}
                  onPetToggle={editor.handlePetToggle}
                  carpetVariant={editor.carpetVariant}
                  carpetColor={editor.carpetColor}
                  carpetAccentColor={editor.carpetAccentColor}
                  onCarpetVariantChange={editor.handleCarpetVariantChange}
                  onCarpetColorChange={editor.handleCarpetColorChange}
                  onCarpetAccentColorChange={editor.handleCarpetAccentColorChange}
                  areas={officeState.getLayout().areas ?? []}
                  selectedAreaLabel={editor.selectedAreaLabel}
                  workspaceFolders={areaFolders}
                  areasAvailable={areasAvailable}
                  areaMappings={areaMappings}
                  onSelectArea={editor.handleSelectArea}
                  onAddArea={editor.handleAddArea}
                  onRemoveArea={editor.handleRemoveArea}
                  onRenameArea={editor.handleRenameArea}
                  onAreaColorChange={editor.handleAreaColorChange}
                  onAreaMappingChange={handleAreaMappingChange}
                />
              );
            })()}

          <ToolOverlay
            officeState={officeState}
            agents={agents}
            agentTools={agentTools}
            subagentTools={subagentTools}
            subagentCharacters={subagentCharacters}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            onCloseAgent={handleCloseAgent}
            onAckTripwire={handleAckTripwire}
            showAreas={showAreas || isEditingAreas}
          />
        </>
      ) : (
        <DebugView
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          subagentTools={subagentTools}
          officeState={officeState}
          onSelectAgent={handleSelectAgent}
        />
      )}

      {/* Hooks first-run tooltip. Gated on hooksInstalled (the hooksStatus
          message), NOT the hooksEnabled preference: hooksEnabled defaults true
          while first-run consent is still pending, and announcing "Instant
          Detection Active" before anything is installed would be a lie. */}
      {hooksEnabled && claudeHooksInstalled && !hooksInfoShown && !hooksTooltipDismissed && (
        <Tooltip
          title="Instant Detection Active"
          position="top-right"
          onDismiss={() => {
            setHooksTooltipDismissed(true);
            transport.send({ type: 'setHooksInfoShown' });
          }}
        >
          <span className="text-sm text-text leading-none">
            Your agents now respond in real-time.{' '}
            <span
              className="text-accent cursor-pointer underline"
              onClick={() => {
                setIsHooksInfoOpen(true);
                setHooksTooltipDismissed(true);
                transport.send({ type: 'setHooksInfoShown' });
              }}
            >
              View more
            </span>
          </span>
        </Tooltip>
      )}

      {/* Hooks info modal */}
      <Modal
        isOpen={isHooksInfoOpen}
        onClose={() => setIsHooksInfoOpen(false)}
        title="Instant Detection is ON"
        zIndex={52}
      >
        <div className="text-base text-text px-10" style={{ lineHeight: 1.4 }}>
          <p className="mb-8">Your pixelmates office now reacts in real-time:</p>
          <ul className="mb-8 pl-18 list-disc m-0">
            <li className="text-sm mb-2">Permission prompts appear instantly</li>
            <li className="text-sm mb-2">Turn completions detected the moment they happen</li>
            <li className="text-sm mb-2">Sound notifications play immediately</li>
          </ul>
          <p className="mb-12 text-text-muted">
            This works through Claude Code Hooks, small event listeners that notify pixelmates
            whenever something happens in your Claude sessions.
          </p>
          <div className="text-center">
            <button
              onClick={() => setIsHooksInfoOpen(false)}
              className="py-4 px-20 text-lg bg-accent text-white border-2 border-accent rounded-none cursor-pointer shadow-pixel"
            >
              Got it
            </button>
          </div>
          <p className="mt-8 text-xs text-text-muted text-center">
            To disable, go to Settings {'>'} Instant Detection
          </p>
        </div>
      </Modal>

      <BottomToolbar
        isEditMode={editor.isEditMode}
        onOpenClaude={editor.handleOpenClaude}
        onToggleEditMode={editor.handleToggleEditMode}
        isSettingsOpen={isSettingsOpen}
        onToggleSettings={() => setIsSettingsOpen((v) => !v)}
        isUsageOpen={isUsageOpen}
        onToggleUsage={() => {
          // Below 1600 px the sheet overlays the Usage panel's corner: opening Usage closes it.
          const { sheetMode } = monitorLayout(window.innerWidth, window.innerHeight);
          if (!isUsageOpen && sheetMode === 'overlay') closeSheet(officeState);
          setIsUsageOpen((v) => !v);
        }}
        workspaceFolders={workspaceFolders}
        zoomControls={
          isDebugMode ? null : (
            <HudCard
              zoom={editor.zoom}
              onZoomChange={handleManualZoom}
              fitActive={fitActive}
              onFit={handleFit}
            />
          )
        }
        privacy={privacy}
        onTogglePrivacy={togglePrivacy}
      />

      {isUsageOpen && (
        <UsagePanel
          usage={tokenUsage}
          limits={usageLimits}
          statuslineInstalled={statuslineInstalled}
          onClose={() => setIsUsageOpen(false)}
        />
      )}

      <VersionIndicator
        currentVersion={extensionVersion}
        lastSeenVersion={lastSeenVersion}
        onDismiss={handleWhatsNewDismiss}
        onOpenChangelog={handleOpenChangelog}
      />

      <ConnectionIndicator />

      <ChangelogModal
        isOpen={isChangelogOpen}
        onClose={() => setIsChangelogOpen(false)}
        currentVersion={extensionVersion}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        isDebugMode={isDebugMode}
        onToggleDebugMode={handleToggleDebugMode}
        ghostHeadlessAgents={ghostHeadlessAgents}
        onToggleGhostHeadlessAgents={handleToggleGhostHeadlessAgents}
        showModelFlair={showModelFlair}
        onToggleShowModelFlair={handleToggleShowModelFlair}
        cozyLighting={cozyLighting}
        onToggleCozyLighting={handleToggleCozyLighting}
        externalAssetDirectories={externalAssetDirectories}
        watchAllSessions={watchAllSessions}
        onToggleWatchAllSessions={() => {
          const newVal = !watchAllSessions;
          setWatchAllSessions(newVal);
          transport.send({ type: 'setWatchAllSessions', enabled: newVal });
        }}
        hooksInstalled={hooksInstalled}
        onToggleHooks={handleToggleHooks}
        showAreas={showAreas}
        onToggleShowAreas={onToggleShowAreas}
        showAreasAvailable={areasAvailable}
        onExportLayout={handleExportLayout}
        onImportLayout={handleImportLayout}
        version={extensionVersion}
        onOpenChangelog={handleOpenChangelog}
        tokenBudget5h={tokenUsage?.budget5h}
        tokenBudgetWeek={tokenUsage?.budgetWeek}
      />

      {showMigrationNotice && (
        <MigrationNotice onDismiss={() => setMigrationNoticeDismissed(true)} />
      )}

      {intro && (
        <IntroBubble
          officeState={officeState}
          headline={intro.headline}
          disclosure={intro.disclosure}
          replaceLegacyLabel={intro.replaceLegacyLabel}
          containerRef={containerRef}
          zoom={editor.zoom}
          panRef={editor.panRef}
          installFailed={installFailed}
          installPending={installPending}
          onChoice={handleConsentChoice}
          onClose={handleIntroClose}
          escapeSuppressed={
            isSettingsOpen ||
            isChangelogOpen ||
            isHooksInfoOpen ||
            showMigrationNotice ||
            editor.isEditMode
          }
        />
      )}
    </div>
  );

  return (
    <MonitorShell
      officeState={officeState}
      agentTools={agentTools}
      agentStatuses={agentStatuses}
      limits={statuslineInstalled ? usageLimits : null}
      statuslineInstalled={statuslineInstalled}
      privacy={privacy}
      onSelect={handleRailSelect}
      inspector={{
        agentTools,
        subagentTools,
        subagentCharacters,
        onAckTripwire: handleAckTripwire,
        onOpen: handleInspectorOpen,
        onSheetLayout: handleSheetLayout,
      }}
    >
      {stage}
    </MonitorShell>
  );
}

export default App;

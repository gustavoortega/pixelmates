import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { ZOOM_SCROLL_THRESHOLD } from '../../constants.js';
import { unlockAudio } from '../../notificationSound.js';
import { transport } from '../../transport/index.js';
import {
  AutoFit,
  clampPan as clampPanToView,
  fitTarget,
  followPan,
  mapFitsView,
  panAfterZoom,
  roomsOf,
  stepZoom,
} from '../camera.js';
import { officeNow } from '../clock.js';
import { getColorizedSprite } from '../colorize.js';
import { crewLines } from '../crewLines.js';
import { canPlaceFurniture, getWallPlacementRow } from '../editor/editorActions.js';
import type { EditorState } from '../editor/editorState.js';
import { type ActivityLevel, busiest, requestRedraw, startGameLoop } from '../engine/gameLoop.js';
import type { OfficeState } from '../engine/officeState.js';
import type {
  DeleteButtonBounds,
  EditorRenderState,
  RotateButtonBounds,
  SelectionRenderState,
} from '../engine/renderer.js';
import { isCozyLightingEnabled, renderFrame } from '../engine/renderer.js';
import { getCatalogEntry, isRotatable } from '../layout/furnitureCatalog.js';
import { lightFixtures, lightingFor, monitorSources, nightDarkness } from '../lighting.js';
import { isMonitorFullPlates } from '../nameplate.js';
import { furnitureForHour, shaftsAt } from '../shafts.js';
import { EditTool, TILE_SIZE } from '../types.js';
import { computeNormalModeCursor } from './officeCanvasCursor.js';

interface OfficeCanvasProps {
  officeState: OfficeState;
  onClick: (agentId: number) => void;
  /** A double-click on an agent: open the inspector on it (the canvas has selected it). */
  onOpenInspector: () => void;
  isEditMode: boolean;
  editorState: EditorState;
  onEditorTileAction: (col: number, row: number) => void;
  onEditorEraseAction: (col: number, row: number) => void;
  onEditorSelectionChange: () => void;
  onDeleteSelected: () => void;
  onRotateSelected: () => void;
  onDragMove: (uid: string, newCol: number, newRow: number) => void;
  editorTick: number;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  panRef: React.MutableRefObject<{ x: number; y: number }>;
  /** Whether the room signs render (settings toggle OR active edit). */
  showAreas: boolean;
  /** The Areas tool is active: the only time the color wash is drawn. */
  isEditingAreas: boolean;
  /** Fit-to-activity controller; manual zoom and pan switch it off. */
  autoFit: AutoFit;
  /** Zoom change made by auto-fit itself (not a manual one, which would switch it off). */
  onAutoZoom: (zoom: number) => void;
  /** Currently-selected area label in the editor (alpha-bumped overlay). null otherwise. */
  activeAreaLabel: string | null;
}

/** Device px of the canvas's right edge an overlay sheet covers (the auto-fit's view inset). */
function insetDevPx(autoFit: AutoFit): number {
  return autoFit.viewInsetCss * (window.devicePixelRatio || 1);
}

export function OfficeCanvas({
  officeState,
  onClick,
  onOpenInspector,
  isEditMode,
  editorState,
  onEditorTileAction,
  onEditorEraseAction,
  onEditorSelectionChange,
  onDeleteSelected,
  onRotateSelected,
  onDragMove,
  editorTick: _editorTick,
  zoom,
  onZoomChange,
  panRef,
  showAreas,
  isEditingAreas,
  autoFit,
  onAutoZoom,
  activeAreaLabel,
}: OfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  // Middle-mouse pan state (imperative, no re-renders)
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 });
  // Delete/rotate button bounds (updated each frame by renderer)
  const deleteButtonBoundsRef = useRef<DeleteButtonBounds | null>(null);
  const rotateButtonBoundsRef = useRef<RotateButtonBounds | null>(null);
  // Right-click erase dragging
  const isEraseDraggingRef = useRef(false);
  // Zoom scroll accumulator for trackpad pinch sensitivity
  const zoomAccumulatorRef = useRef(0);
  // Auto-fit pan computed for a zoom the canvas has not reached yet; applied once it does.
  const pendingFitRef = useRef<{ pan: { x: number; y: number }; panZoom: number } | null>(null);
  // Zoom the canvas last drew at, and where a wheel zoom was aimed (device px; null = viewport centre).
  const prevZoomRef = useRef(zoom);
  const zoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  // What the canvas itself still moves (the editor, a fit easing, a follow not yet landed), read
  // off every drawn frame. The loop runs at the busier of this and the office's own level.
  const canvasActivityRef = useRef<ActivityLevel>('idle');

  // Legal pan for the current zoom: a small map stays centred, a big one never shows void, both
  // in the part of the canvas an overlay sheet leaves uncovered.
  const clampPan = useCallback(
    (px: number, py: number): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: px, y: py };
      const layout = officeState.getLayout();
      return clampPanToView(
        { x: px, y: py },
        { width: canvas.width, height: canvas.height },
        { cols: layout.cols, rows: layout.rows },
        zoom,
        insetDevPx(autoFit),
      );
    },
    [officeState, zoom, autoFit],
  );

  // A zoom change keeps the world point under its anchor still: the viewport centre for the
  // buttons, the cursor for the wheel. An auto-fit zoom brings its own pan, which wins.
  // A layout effect, so the overlays never see the new zoom with the old pan for a paint.
  useLayoutEffect(() => {
    const prev = prevZoomRef.current;
    prevZoomRef.current = zoom;
    const canvas = canvasRef.current;
    if (prev === zoom || !canvas) return;
    const layout = officeState.getLayout();
    const map = { cols: layout.cols, rows: layout.rows };
    const view = { width: canvas.width, height: canvas.height };
    const inset = insetDevPx(autoFit);
    const pending = pendingFitRef.current;
    if (pending && pending.panZoom === zoom) {
      panRef.current = clampPanToView(pending.pan, view, map, zoom, inset);
      pendingFitRef.current = null;
    } else {
      const anchor = zoomAnchorRef.current ?? { x: (view.width - inset) / 2, y: view.height / 2 };
      panRef.current = panAfterZoom(anchor, panRef.current, prev, zoom, view, map, inset);
    }
    zoomAnchorRef.current = null;
  }, [zoom, officeState, panRef, autoFit]);

  // Resize canvas backing store to device pixels (no DPR transform on ctx)
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    // No ctx.scale(dpr) — we render directly in device pixels
    // Setting the size clears the canvas: draw it again now, not at the next idle redraw.
    requestRedraw();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    resizeCanvas();

    const observer = new ResizeObserver(() => resizeCanvas());
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    const ctx = canvas.getContext('2d')!;
    const loop = startGameLoop(
      (dt) => officeState.update(dt),
      ({ dt, now: frameNowMs }) => {
        ctx.imageSmoothingEnabled = false;
        // Canvas dimensions are in device pixels
        const w = canvas.width;
        const h = canvas.height;
        // The editor draws ghosts and handles under the cursor: it keeps the loop on every frame.
        let canvasActivity: ActivityLevel = isEditMode ? 'active' : 'idle';

        // Build editor render state
        let editorRender: EditorRenderState | undefined;
        if (isEditMode) {
          const showGhostBorder =
            editorState.activeTool === EditTool.TILE_PAINT ||
            editorState.activeTool === EditTool.WALL_PAINT ||
            editorState.activeTool === EditTool.ERASE;
          editorRender = {
            showGrid: true,
            ghostSprite: null,
            ghostMirrored: false,
            ghostCol: editorState.ghostCol,
            ghostRow: editorState.ghostRow,
            ghostValid: editorState.ghostValid,
            selectedCol: 0,
            selectedRow: 0,
            selectedW: 0,
            selectedH: 0,
            hasSelection: false,
            isRotatable: false,
            deleteButtonBounds: null,
            rotateButtonBounds: null,
            showGhostBorder,
            ghostBorderHoverCol: showGhostBorder ? editorState.ghostCol : -999,
            ghostBorderHoverRow: showGhostBorder ? editorState.ghostRow : -999,
          };

          // Ghost preview for furniture placement
          if (editorState.activeTool === EditTool.FURNITURE_PLACE && editorState.ghostCol >= 0) {
            const entry = getCatalogEntry(editorState.selectedFurnitureType);
            if (entry) {
              const placementRow = getWallPlacementRow(
                editorState.selectedFurnitureType,
                editorState.ghostRow,
              );
              const pickedColor = editorState.pickedFurnitureColor;
              editorRender.ghostSprite = pickedColor
                ? getColorizedSprite(entry.sprite, pickedColor)
                : entry.sprite;
              editorRender.ghostRow = placementRow;
              editorRender.ghostMirrored =
                !!entry.mirrorSide && editorState.selectedFurnitureType.endsWith(':left');
              editorRender.ghostValid = canPlaceFurniture(
                officeState.getLayout(),
                editorState.selectedFurnitureType,
                editorState.ghostCol,
                placementRow,
              );
            }
          }

          // Ghost preview for drag-to-move
          if (editorState.isDragMoving && editorState.dragUid && editorState.ghostCol >= 0) {
            const draggedItem = officeState
              .getLayout()
              .furniture.find((f) => f.uid === editorState.dragUid);
            if (draggedItem) {
              const entry = getCatalogEntry(draggedItem.type);
              if (entry) {
                const ghostCol = editorState.ghostCol - editorState.dragOffsetCol;
                const ghostRow = editorState.ghostRow - editorState.dragOffsetRow;
                editorRender.ghostSprite = entry.sprite;
                editorRender.ghostCol = ghostCol;
                editorRender.ghostRow = ghostRow;
                editorRender.ghostMirrored =
                  !!entry.mirrorSide && draggedItem.type.endsWith(':left');
                editorRender.ghostValid = canPlaceFurniture(
                  officeState.getLayout(),
                  draggedItem.type,
                  ghostCol,
                  ghostRow,
                  editorState.dragUid,
                );
              }
            }
          }

          // Selection highlight
          if (editorState.selectedFurnitureUid && !editorState.isDragMoving) {
            const item = officeState
              .getLayout()
              .furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
            if (item) {
              const entry = getCatalogEntry(item.type);
              if (entry) {
                editorRender.hasSelection = true;
                editorRender.selectedCol = item.col;
                editorRender.selectedRow = item.row;
                editorRender.selectedW = entry.footprintW;
                editorRender.selectedH = entry.footprintH;
                editorRender.isRotatable = isRotatable(item.type);
              }
            }
          }
        }

        // A follow while the whole map fits the view (its outer wall may be cut) barely moves it
        // and would only switch the fit off: a selection follows only a map bigger than the view.
        if (officeState.cameraFollowId !== null) {
          const l = officeState.getLayout();
          const fits = mapFitsView(
            l.cols * TILE_SIZE * zoom,
            l.rows * TILE_SIZE * zoom,
            w - insetDevPx(autoFit),
            h,
          );
          if (fits) officeState.cameraFollowId = null;
        }

        // Fit to activity: frame the rooms where agents work; any manual camera move switched it off.
        {
          const layoutForFit = officeState.getLayout();
          const dprFit = window.devicePixelRatio || 1;
          const pending = pendingFitRef.current;
          if (pending && pending.panZoom === zoom) {
            panRef.current = pending.pan;
            pendingFitRef.current = null;
          }
          const cmd = autoFit.step({
            target: fitTarget(roomsOf(layoutForFit), officeState.fitAgents()),
            map: { cols: layoutForFit.cols, rows: layoutForFit.rows },
            canvas: { width: w / dprFit, height: h / dprFit },
            dpr: dprFit,
            zoom,
            pan: panRef.current,
            nowMs: frameNowMs,
            editing: isEditMode,
            followed: officeState.cameraFollowId !== null || !!officeState.greeterCameraTarget,
          });
          if (cmd.easing) canvasActivity = 'active';
          // The sheet keeps the office's size over showing all of it: frame its agent instead.
          if (cmd.followSelected) officeState.cameraFollowId = officeState.selectedAgentId;
          if (cmd.zoom !== undefined && cmd.zoom !== zoom) onAutoZoom(cmd.zoom);
          if (cmd.pan && cmd.panZoom !== undefined) {
            if (cmd.panZoom === zoom) panRef.current = cmd.pan;
            else pendingFitRef.current = { pan: cmd.pan, panZoom: cmd.panZoom };
          }
        }

        // Camera: smoothly center on the followed agent, or — while the greeter
        // is speaking the Intro — on the character+bubble center the IntroBubble
        // overlay feeds via greeterCameraTarget. An explicit follow (clicking an
        // agent) outranks the greeter target; a manual pan cancels both.
        const followCh =
          officeState.cameraFollowId !== null
            ? officeState.characters.get(officeState.cameraFollowId)
            : undefined;
        const cameraFocus = followCh ?? officeState.greeterCameraTarget;
        if (cameraFocus) {
          const layout = officeState.getLayout();
          const mapW = layout.cols * TILE_SIZE * zoom;
          const mapH = layout.rows * TILE_SIZE * zoom;
          // Centred in the view an overlay sheet leaves uncovered.
          const inset = insetDevPx(autoFit);
          const follow = followPan(
            panRef.current,
            { x: mapW / 2 - cameraFocus.x * zoom - inset / 2, y: mapH / 2 - cameraFocus.y * zoom },
            dt,
            (p) =>
              clampPanToView(
                p,
                { width: w, height: h },
                { cols: layout.cols, rows: layout.rows },
                zoom,
                inset,
              ),
          );
          panRef.current = follow.pan;
          if (!follow.settled) canvasActivity = 'active';
        }
        // The Intro bubble re-aims the greeter camera after every frame.
        if (officeState.greeterCameraTarget) canvasActivity = 'active';
        canvasActivityRef.current = canvasActivity;

        // Build selection render state
        const selectionRender: SelectionRenderState = {
          selectedAgentId: officeState.selectedAgentId,
          hoveredAgentId: officeState.hoveredAgentId,
          hoveredTile: officeState.hoveredTile,
          seats: officeState.seats,
          characters: officeState.characters,
        };

        const layout = officeState.getLayout();
        const now = officeNow();
        const darkness = nightDarkness(now.getHours(), now.getMinutes());
        const { offsetX, offsetY } = renderFrame(
          ctx,
          w,
          h,
          officeState.tileMap,
          isCozyLightingEnabled()
            ? furnitureForHour(officeState.furniture, now.getHours(), now.getMinutes())
            : officeState.furniture,
          officeState.getCharacters(),
          zoom,
          panRef.current.x,
          panRef.current.y,
          selectionRender,
          editorRender,
          layout.tileColors,
          layout.cols,
          layout.rows,
          layout.carpetTiles,
          layout.areas,
          layout.areaTiles,
          // Beside the rail the rooms carry DOM plaques (ToolOverlay); the canvas signs would repeat them.
          showAreas && !isMonitorFullPlates(),
          activeAreaLabel,
          officeState.pets,
          officeState.tripwires,
          officeState.areaUsage,
          {
            models: officeState.models,
            companions: officeState.companions.values(),
            nowMs: frameNowMs,
          },
          isEditingAreas,
          {
            lighting: lightingFor(now.getHours(), now.getMinutes()),
            sources: monitorSources(officeState.characters.values(), officeState.seats),
            fixtures: lightFixtures(layout.furniture),
            shafts: shaftsAt(layout, now),
            darkness,
            monitors: darkness > 0 ? officeState.litMonitorTiles() : [],
            nowMs: now.getTime(),
          },
          {
            effects: officeState.fx.active,
            weather: officeState.weather,
            nowMs: Date.now(),
            anchors: officeState.weatherAnchor,
          },
          officeState.deskProps,
          officeState.bubbleLift,
          officeState.health,
          crewLines(officeState),
          officeState.deskHighlights(),
          officeState,
        );
        offsetRef.current = { x: offsetX, y: offsetY };

        // Store delete/rotate button bounds for hit-testing
        deleteButtonBoundsRef.current = editorRender?.deleteButtonBounds ?? null;
        rotateButtonBoundsRef.current = editorRender?.rotateButtonBounds ?? null;
      },
      { activity: () => busiest(officeState.activityLevel(), canvasActivityRef.current) },
    );

    // Off screen nothing ticks. A VS Code panel kept alive but not shown stops animation frames
    // while its timers run on, and only the canvas leaving the viewport tells.
    let pageVisible = document.visibilityState === 'visible';
    let onScreen = true;
    const applyVisibility = (): void => loop.setVisible(pageVisible && onScreen);
    const onVisibilityChange = (): void => {
      pageVisible = document.visibilityState === 'visible';
      applyVisibility();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const intersection =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            const last = entries[entries.length - 1];
            if (!last) return;
            onScreen = last.isIntersecting;
            applyVisibility();
          });
    intersection?.observe(canvas);
    if (!pageVisible) applyVisibility();

    return () => {
      loop.stop();
      observer.disconnect();
      intersection?.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    officeState,
    resizeCanvas,
    isEditMode,
    editorState,
    _editorTick,
    zoom,
    panRef,
    showAreas,
    isEditingAreas,
    autoFit,
    onAutoZoom,
    activeAreaLabel,
  ]);

  // Convert CSS mouse coords to world (sprite pixel) coords
  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // CSS coords relative to canvas
      const cssX = clientX - rect.left;
      const cssY = clientY - rect.top;
      // Convert to device pixels
      const deviceX = cssX * dpr;
      const deviceY = cssY * dpr;
      // Convert to world (sprite pixel) coords
      const worldX = (deviceX - offsetRef.current.x) / zoom;
      const worldY = (deviceY - offsetRef.current.y) / zoom;
      return { worldX, worldY, screenX: cssX, screenY: cssY, deviceX, deviceY };
    },
    [zoom],
  );

  const screenToTile = useCallback(
    (clientX: number, clientY: number): { col: number; row: number } | null => {
      const pos = screenToWorld(clientX, clientY);
      if (!pos) return null;
      const col = Math.floor(pos.worldX / TILE_SIZE);
      const row = Math.floor(pos.worldY / TILE_SIZE);
      const layout = officeState.getLayout();
      // In edit mode with floor/wall/erase tool, extend valid range by 1 for ghost border
      if (
        isEditMode &&
        (editorState.activeTool === EditTool.TILE_PAINT ||
          editorState.activeTool === EditTool.WALL_PAINT ||
          editorState.activeTool === EditTool.ERASE)
      ) {
        if (col < -1 || col > layout.cols || row < -1 || row > layout.rows) return null;
        return { col, row };
      }
      if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return null;
      return { col, row };
    },
    [screenToWorld, officeState, isEditMode, editorState],
  );

  // Check if device-pixel coords hit the delete button
  const hitTestDeleteButton = useCallback((deviceX: number, deviceY: number): boolean => {
    const bounds = deleteButtonBoundsRef.current;
    if (!bounds) return false;
    const dx = deviceX - bounds.cx;
    const dy = deviceY - bounds.cy;
    return dx * dx + dy * dy <= (bounds.radius + 2) * (bounds.radius + 2); // small padding
  }, []);

  // Check if device-pixel coords hit the rotate button
  const hitTestRotateButton = useCallback((deviceX: number, deviceY: number): boolean => {
    const bounds = rotateButtonBoundsRef.current;
    if (!bounds) return false;
    const dx = deviceX - bounds.cx;
    const dy = deviceY - bounds.cy;
    return dx * dx + dy * dy <= (bounds.radius + 2) * (bounds.radius + 2);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      requestRedraw();
      // Handle middle-mouse panning
      if (isPanningRef.current) {
        const dpr = window.devicePixelRatio || 1;
        const dx = (e.clientX - panStartRef.current.mouseX) * dpr;
        const dy = (e.clientY - panStartRef.current.mouseY) * dpr;
        panRef.current = clampPan(panStartRef.current.panX + dx, panStartRef.current.panY + dy);
        return;
      }

      if (isEditMode) {
        const tile = screenToTile(e.clientX, e.clientY);
        if (tile) {
          editorState.ghostCol = tile.col;
          editorState.ghostRow = tile.row;

          // Drag-to-move: check if cursor moved to different tile
          if (editorState.dragUid && !editorState.isDragMoving) {
            if (tile.col !== editorState.dragStartCol || tile.row !== editorState.dragStartRow) {
              editorState.isDragMoving = true;
            }
          }

          // Paint on drag (paint-style tools only, not during furniture drag).
          // Carpet + Area paint join the drag set so a single click-drag stamps
          // every tile under the cursor — stroke-based undo lives in
          // useEditorActions for carpet, per-tile undo for area.
          if (
            editorState.isDragging &&
            (editorState.activeTool === EditTool.TILE_PAINT ||
              editorState.activeTool === EditTool.WALL_PAINT ||
              editorState.activeTool === EditTool.ERASE ||
              editorState.activeTool === EditTool.CARPET_PAINT ||
              editorState.activeTool === EditTool.AREA_PAINT) &&
            !editorState.dragUid
          ) {
            onEditorTileAction(tile.col, tile.row);
          }
          // Right-click erase drag — also extends over carpets/areas so right-
          // drag wipes them just like floor/wall.
          if (
            isEraseDraggingRef.current &&
            (editorState.activeTool === EditTool.TILE_PAINT ||
              editorState.activeTool === EditTool.WALL_PAINT ||
              editorState.activeTool === EditTool.ERASE ||
              editorState.activeTool === EditTool.CARPET_PAINT ||
              editorState.activeTool === EditTool.AREA_PAINT)
          ) {
            const layout = officeState.getLayout();
            if (
              tile.col >= 0 &&
              tile.col < layout.cols &&
              tile.row >= 0 &&
              tile.row < layout.rows
            ) {
              onEditorEraseAction(tile.col, tile.row);
            }
          }
        } else {
          editorState.ghostCol = -1;
          editorState.ghostRow = -1;
        }

        // Cursor: show grab during drag, pointer over delete button, crosshair otherwise
        const canvas = canvasRef.current;
        if (canvas) {
          if (editorState.isDragMoving) {
            canvas.style.cursor = 'grabbing';
          } else {
            const pos = screenToWorld(e.clientX, e.clientY);
            if (
              pos &&
              (hitTestDeleteButton(pos.deviceX, pos.deviceY) ||
                hitTestRotateButton(pos.deviceX, pos.deviceY))
            ) {
              canvas.style.cursor = 'pointer';
            } else if (editorState.activeTool === EditTool.FURNITURE_PICK && tile) {
              // Pick mode: show pointer over furniture, crosshair elsewhere
              const layout = officeState.getLayout();
              const hitFurniture = layout.furniture.find((f) => {
                const entry = getCatalogEntry(f.type);
                if (!entry) return false;
                return (
                  tile.col >= f.col &&
                  tile.col < f.col + entry.footprintW &&
                  tile.row >= f.row &&
                  tile.row < f.row + entry.footprintH
                );
              });
              canvas.style.cursor = hitFurniture ? 'pointer' : 'crosshair';
            } else if (
              (editorState.activeTool === EditTool.SELECT ||
                (editorState.activeTool === EditTool.FURNITURE_PLACE &&
                  editorState.selectedFurnitureType === '')) &&
              tile
            ) {
              // Check if hovering over furniture
              const layout = officeState.getLayout();
              const hitFurniture = layout.furniture.find((f) => {
                const entry = getCatalogEntry(f.type);
                if (!entry) return false;
                return (
                  tile.col >= f.col &&
                  tile.col < f.col + entry.footprintW &&
                  tile.row >= f.row &&
                  tile.row < f.row + entry.footprintH
                );
              });
              canvas.style.cursor = hitFurniture ? 'grab' : 'crosshair';
            } else {
              canvas.style.cursor = 'crosshair';
            }
          }
        }
        return;
      }

      const pos = screenToWorld(e.clientX, e.clientY);
      if (!pos) return;
      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY);
      // Only run pet hit-test if no character was hit (avoids redundant work).
      const petId = hitId === null ? officeState.getPetAt(pos.worldX, pos.worldY) : null;
      const tile = screenToTile(e.clientX, e.clientY);
      officeState.hoveredTile = tile;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.cursor = computeNormalModeCursor({
          hitId,
          petId,
          selectedAgentId: officeState.selectedAgentId,
          tile,
          getSeatAtTile: (col, row) => officeState.getSeatAtTile(col, row),
          getSeat: (seatId) => officeState.seats.get(seatId),
          getCharacter: (id) => officeState.characters.get(id),
        });
      }
      officeState.hoveredAgentId = hitId;
    },
    [
      officeState,
      screenToWorld,
      screenToTile,
      isEditMode,
      editorState,
      onEditorTileAction,
      onEditorEraseAction,
      panRef,
      hitTestDeleteButton,
      hitTestRotateButton,
      clampPan,
    ],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      requestRedraw();
      unlockAudio();
      // Middle mouse button (button 1) starts panning
      if (e.button === 1) {
        e.preventDefault();
        // Break camera follow + greeter centering on manual pan
        officeState.cameraFollowId = null;
        officeState.cancelGreeterCamera();
        autoFit.disable();
        isPanningRef.current = true;
        panStartRef.current = {
          mouseX: e.clientX,
          mouseY: e.clientY,
          panX: panRef.current.x,
          panY: panRef.current.y,
        };
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'grabbing';
        return;
      }

      // Right-click in edit mode for erasing
      if (e.button === 2 && isEditMode) {
        const tile = screenToTile(e.clientX, e.clientY);
        if (
          tile &&
          (editorState.activeTool === EditTool.TILE_PAINT ||
            editorState.activeTool === EditTool.WALL_PAINT ||
            editorState.activeTool === EditTool.ERASE ||
            editorState.activeTool === EditTool.CARPET_PAINT ||
            editorState.activeTool === EditTool.AREA_PAINT)
        ) {
          const layout = officeState.getLayout();
          if (tile.col >= 0 && tile.col < layout.cols && tile.row >= 0 && tile.row < layout.rows) {
            isEraseDraggingRef.current = true;
            onEditorEraseAction(tile.col, tile.row);
          }
        }
        return;
      }

      if (!isEditMode) return;

      // Check rotate/delete button hit first
      const pos = screenToWorld(e.clientX, e.clientY);
      if (pos && hitTestRotateButton(pos.deviceX, pos.deviceY)) {
        onRotateSelected();
        return;
      }
      if (pos && hitTestDeleteButton(pos.deviceX, pos.deviceY)) {
        onDeleteSelected();
        return;
      }

      const tile = screenToTile(e.clientX, e.clientY);

      // SELECT tool (or furniture tool with nothing selected): check for furniture hit to start drag
      const actAsSelect =
        editorState.activeTool === EditTool.SELECT ||
        (editorState.activeTool === EditTool.FURNITURE_PLACE &&
          editorState.selectedFurnitureType === '');
      if (actAsSelect && tile) {
        const layout = officeState.getLayout();
        // Find all furniture at clicked tile, prefer surface items (on top of desks)
        let hitFurniture = null as (typeof layout.furniture)[0] | null;
        for (const f of layout.furniture) {
          const entry = getCatalogEntry(f.type);
          if (!entry) continue;
          if (
            tile.col >= f.col &&
            tile.col < f.col + entry.footprintW &&
            tile.row >= f.row &&
            tile.row < f.row + entry.footprintH
          ) {
            if (!hitFurniture || entry.canPlaceOnSurfaces) hitFurniture = f;
          }
        }
        if (hitFurniture) {
          // Start drag — record offset from furniture's top-left
          editorState.startDrag(
            hitFurniture.uid,
            tile.col,
            tile.row,
            tile.col - hitFurniture.col,
            tile.row - hitFurniture.row,
          );
          return;
        } else {
          // Clicked empty space — deselect
          editorState.clearSelection();
          onEditorSelectionChange();
        }
      }

      // Non-select tools: start paint drag
      editorState.isDragging = true;
      if (tile) {
        onEditorTileAction(tile.col, tile.row);
      }
    },
    [
      officeState,
      isEditMode,
      editorState,
      screenToTile,
      screenToWorld,
      onEditorTileAction,
      onEditorEraseAction,
      onEditorSelectionChange,
      onDeleteSelected,
      onRotateSelected,
      hitTestDeleteButton,
      hitTestRotateButton,
      panRef,
      autoFit,
    ],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      requestRedraw();
      if (e.button === 1) {
        isPanningRef.current = false;
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = isEditMode ? 'crosshair' : 'default';
        return;
      }
      if (e.button === 2) {
        isEraseDraggingRef.current = false;
        // Close any in-progress carpet / area stroke so the next stroke
        // starts a fresh undo entry instead of bundling into this one.
        editorState.carpetStrokeInitialLayout = null;
        editorState.carpetDragErasing = null;
        editorState.areaDragErasing = null;
        return;
      }

      // Handle drag-to-move completion
      if (editorState.dragUid) {
        if (editorState.isDragMoving) {
          // Compute target position
          const ghostCol = editorState.ghostCol - editorState.dragOffsetCol;
          const ghostRow = editorState.ghostRow - editorState.dragOffsetRow;
          const draggedItem = officeState
            .getLayout()
            .furniture.find((f) => f.uid === editorState.dragUid);
          if (draggedItem) {
            const valid = canPlaceFurniture(
              officeState.getLayout(),
              draggedItem.type,
              ghostCol,
              ghostRow,
              editorState.dragUid,
            );
            if (valid) {
              onDragMove(editorState.dragUid, ghostCol, ghostRow);
            }
          }
          editorState.clearSelection();
        } else {
          // Click (no movement) — toggle selection
          if (editorState.selectedFurnitureUid === editorState.dragUid) {
            editorState.clearSelection();
          } else {
            editorState.selectedFurnitureUid = editorState.dragUid;
          }
        }
        editorState.clearDrag();
        onEditorSelectionChange();
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'crosshair';
        return;
      }

      editorState.isDragging = false;
      editorState.wallDragAdding = null;
      // Close the current carpet stroke so the next click starts a fresh undo entry.
      editorState.carpetStrokeInitialLayout = null;
      editorState.carpetDragErasing = null;
      editorState.areaDragErasing = null;
    },
    [editorState, isEditMode, officeState, onDragMove, onEditorSelectionChange],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEditMode) return;
      const pos = screenToWorld(e.clientX, e.clientY);
      if (!pos) return;
      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY);
      if (hitId === null) return;
      officeState.selectedAgentId = hitId;
      officeState.cameraFollowId = hitId;
      requestRedraw();
      onOpenInspector();
    },
    [officeState, onOpenInspector, screenToWorld, isEditMode],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      requestRedraw();
      if (isEditMode) return; // handled by mouseDown/mouseUp
      const pos = screenToWorld(e.clientX, e.clientY);
      if (!pos) return;

      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY);
      if (hitId !== null) {
        // Dismiss any active bubble on click
        officeState.dismissBubble(hitId);
        // A hit always selects (a second click keeps it, so a double-click can open the sheet);
        // deselect is an empty click or Esc.
        officeState.selectedAgentId = hitId;
        officeState.cameraFollowId = hitId;
        onClick(hitId); // still focus terminal
        return;
      }

      // Pet hit: toggle the heart bubble.
      const petId = officeState.getPetAt(pos.worldX, pos.worldY);
      if (petId !== null) {
        const pet = officeState.pets.find((p) => p.id === petId);
        if (pet?.bubbleType) {
          officeState.dismissPetBubble(petId);
        } else {
          officeState.showPetBubble(petId);
        }
        return;
      }

      // No agent hit — check seat click while agent is selected
      if (officeState.selectedAgentId !== null) {
        const selectedCh = officeState.characters.get(officeState.selectedAgentId);
        // Skip seat reassignment for sub-agents
        if (selectedCh && !selectedCh.isSubagent) {
          const tile = screenToTile(e.clientX, e.clientY);
          if (tile) {
            const seatId = officeState.getSeatAtTile(tile.col, tile.row);
            if (seatId) {
              const seat = officeState.seats.get(seatId);
              if (seat && selectedCh) {
                if (selectedCh.seatId === seatId) {
                  // Clicked own seat — send agent back to it
                  officeState.sendToSeat(officeState.selectedAgentId);
                  officeState.selectedAgentId = null;
                  officeState.cameraFollowId = null;
                  return;
                } else if (!seat.assigned) {
                  // Clicked available seat — reassign
                  officeState.reassignSeat(officeState.selectedAgentId, seatId);
                  officeState.selectedAgentId = null;
                  officeState.cameraFollowId = null;
                  transport.send({
                    type: 'saveAgentSeats',
                    seats: officeState.getPersistableSeats(),
                  });
                  return;
                }
              }
            }
          }
        }
        // Clicked empty space — deselect
        officeState.selectedAgentId = null;
        officeState.cameraFollowId = null;
      }
    },
    [officeState, onClick, screenToWorld, screenToTile, isEditMode],
  );

  const handleMouseLeave = useCallback(() => {
    requestRedraw();
    isPanningRef.current = false;
    isEraseDraggingRef.current = false;
    editorState.isDragging = false;
    editorState.wallDragAdding = null;
    editorState.carpetStrokeInitialLayout = null;
    editorState.carpetDragErasing = null;
    editorState.areaDragErasing = null;
    editorState.clearDrag();
    editorState.ghostCol = -1;
    editorState.ghostRow = -1;
    officeState.hoveredAgentId = null;
    officeState.hoveredTile = null;

    // Reset cursor in non-edit mode so pointer doesn't get stuck after hovering a pet.
    if (!isEditMode) {
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.cursor = 'default';
      }
    }
  }, [officeState, editorState, isEditMode]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      requestRedraw();
      e.preventDefault();
      if (isEditMode) return;
      // Right-click to walk selected agent to tile
      if (officeState.selectedAgentId !== null) {
        const tile = screenToTile(e.clientX, e.clientY);
        if (tile) {
          officeState.walkToTile(officeState.selectedAgentId, tile.col, tile.row);
        }
      }
    },
    [isEditMode, officeState, screenToTile],
  );

  // Wheel: Ctrl+wheel to zoom, plain wheel/trackpad to pan
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      requestRedraw();
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Accumulate scroll delta, step zoom when threshold crossed
        zoomAccumulatorRef.current += e.deltaY;
        if (Math.abs(zoomAccumulatorRef.current) >= ZOOM_SCROLL_THRESHOLD) {
          const dir = zoomAccumulatorRef.current < 0 ? 1 : -1;
          zoomAccumulatorRef.current = 0;
          const newZoom = stepZoom(zoom, dir);
          if (newZoom !== zoom) {
            // The wheel zooms toward the cursor: the world point under it stays under it.
            const rect = canvasRef.current?.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            zoomAnchorRef.current = rect
              ? { x: (e.clientX - rect.left) * dpr, y: (e.clientY - rect.top) * dpr }
              : null;
            onZoomChange(newZoom);
          }
        }
      } else {
        // Pan via trackpad two-finger scroll or mouse wheel
        const dpr = window.devicePixelRatio || 1;
        officeState.cameraFollowId = null;
        officeState.cancelGreeterCamera();
        autoFit.disable();
        panRef.current = clampPan(
          panRef.current.x - e.deltaX * dpr,
          panRef.current.y - e.deltaY * dpr,
        );
      }
    },
    [zoom, onZoomChange, officeState, panRef, clampPan, autoFit],
  );

  // Attach wheel listener with { passive: false } so preventDefault() works.
  // React's onWheel is passive by default in modern browsers.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Prevent default middle-click browser behavior (auto-scroll)
  const handleAuxClick = useCallback((e: React.MouseEvent) => {
    requestRedraw();
    if (e.button === 1) e.preventDefault();
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative overflow-hidden"
      style={{ background: 'var(--page-bg)' }}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onAuxClick={handleAuxClick}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
        className="block"
      />
    </div>
  );
}

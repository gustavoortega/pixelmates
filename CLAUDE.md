# pixelmates — Compressed Reference

Pixel art office where AI agents (Claude Code terminals today, any tool tomorrow) become animated characters. Ships as a **VS Code extension** and an **`npx pixelmates` standalone CLI** from the same source tree.

`CONTEXT.md` is the canonical glossary — read it for what terms like Agent, Sub-agent, Teammate, Lead, Adopt, or Headless agent mean here, and use its vocabulary in code, comments, and docs.

## Architecture

Strict layering: `core/` depends on nothing; `server/` depends only on `core/`; `webview-ui/` depends only on `core/`; `adapters/vscode/` depends on `core/` and `server/`. The standalone CLI never imports `adapters/vscode/` and vice versa.

```
core/                                Protocol + interface definitions (zero runtime side effects)
  asyncapi.yaml                      AsyncAPI 3.0 contract — single source of truth
  src/
    messages.ts                      AUTO-GENERATED discriminated unions (do not edit)
    schemas.ts                       AgentMeta, SpriteData, FurnitureCatalogEntry
    provider.ts                      HookProvider, AgentEvent (the integration boundary)
    teamProvider.ts                  Optional TeamProvider (semantic queries for Lead + Teammates)
    transport.ts                     MessageTransport interface, TransportState
    adapter.ts                       StateAdapter, AssetCache, PersistedAgent, AgentSeat
    terminalAdapter.ts               TerminalAdapter (editor-driven terminal management)
    normalizeProjectPath.ts
    constants.ts

server/                              Lifecycle runtime + Fastify HTTP/WS server
  src/
    providers/hook/claude/           Reference HookProvider — only place that knows Claude specifics
      claude.ts                      normalizeHookEvent for 11 Claude events, formatToolStatus, file fallback, XP signals (toolVerdicts, resultSignals)
      claudeTeamProvider.ts          TeamProvider: reads ~/.claude/teams/<name>/config.json
      claudeHookInstaller.ts         Consent-gated install/uninstall in ~/.claude/settings.json (abort on unparseable file or non-array hooks.<Event>; one-time .pixelmates.backup, exclusive-create, no backup ⇒ no write — but skipped when the replaced content is entirely our own install's output, since backing up our own file masquerades as the user's original (`settingsHoldOnlyOurs`, compared against makeHookEntry — the WRITER — so a field added to what we write can't silently revive the bug; only `command`/`timeout` may differ, they vary across installs; a `statusLine` counts as ours only as makeTeeOnlyStatusLine(), the wrapper with no argument); every write failure THROWS; mode preserved, 0600 on create; re-read verify immediately before rename + retry; hook identity = `/.pixelmates/hooks/claude-hook.js` suffix anchored at both ends of the command's first token, case-insensitive; `areHooksInstalled` = ANY of our commands on ANY event)
      consentCopy.ts                 Consent disclosure text (scope/data/undo) for the hooks and for the status line wrapper, served through consentDisclosure()
      sessionFiles.ts                Session liveness from ~/.claude/sessions/<pid>.json: kill(pid, 0), then one `ps` name check for reused pids
      constants.ts                   Claude hook event names, bundled script names, the wrapper's stdin cap and POST budget
      hooks/claude-hook.ts           Hook script (CJS+shebang, bundled to dist/hooks/claude-hook.js)
      hooks/statusline-tee.ts        Status line wrapper (bundled to dist/hooks/statusline-tee.js): runs the user's statusLine command untouched, POSTs only rate_limits.five_hour/seven_day
      hooks/scriptDebugLog.ts        Opt-in PIXELMATES_DEBUG_LOG file logger shared by both bundled scripts
      serverTargets.ts               readServerTargets(home): live servers/*.json entries, else the legacy server.json (both scripts fan out alike)
      claudeStatusline.ts            claudeStatuslineProvider ('claude-statusline', off by default): the wrapper as a second provider, so it reuses the consent machinery; hook-event members are inert
      claudeStatuslineInstaller.ts   Chains/unchains the wrapper in statusLine.command through claudeHookInstaller's guarded write; restore source = the chained command's argument (docs/adr/0002)
      commandIdentity.ts             Leaf module: the script-token rule both installers share, plus the wrapper command's writer and parser
    providers/hook/consentGate.ts    Provider-agnostic consent POLICY: when to ask (hooksConsentRequest per provider) and what an answer means (consentActionFor(choice, {installed, consent}) — see docs/adr/0001)
    providers/hook/consentExecutor.ts Provider-agnostic consent EXECUTION: applyConsentChoice(providerId, choice, ConsentEffects) runs the six actions in one order for both surfaces, and SERIALIZES answers per process across ALL providers
    providers/index.ts               Provider registry (claudeProvider + claudeStatuslineProvider, the hookProviders list the consent gate loops over)
    agentRuntime.ts                  Lifecycle core: timers, scanners, HookEventHandler, SessionRouter, DismissalTracker
    agentStateStore.ts               EventEmitter-backed single source of truth (typed mutations + events)
    sessionRouter.ts                 session_id → agent_id mapping, event buffering, pending external sessions
    tripwires.ts                     Tripwire engine (pure): evaluateTripwires, applyTripwireHit, ackTripwire
    tripwireDefaults.ts              Built-in tripwire rule pack (14 rules)
    tripwireConfig.ts                Loads ~/.pixelmates/tripwires.json over the defaults (validated, once at startup)
    health.ts                        Health detectors (stuck, stalled, looping, dead): per-agent counters and clocks, compare-and-broadcast
    healthTick.ts                    30 s health tick: provider liveness, the stall clock, removal of dead external agents
    testSummary.ts                   parseTestSummary: a test runner's pass/fail counts from shell output (the stuck detector; XP reads its green run in claude.ts)
    monitorFacts.ts                  Artifacts, loop and test runs as one reducer (`feedFacts`): the live parser and the history scan feed the same function; a publish is keyed by its result url, history is absorbed under the live part; titles and urls are never logged
    historyScan.ts                   History scan: one queue, one scan at a time, 0..watch offset under a 2 s / 64 MiB Budget (memory/reader.ts), lines over 1 MiB skipped; `registerHistoryConsumer` lets another reducer (the cost) read the same pass
    roster.ts                        RosterStore: persistent crew over ~/.pixelmates/roster.json (O_EXCL lockfile, holds by pid, re-read + delta merge on write)
    rosterAgent.ts                   claimRosterMember, agentRoster message, roster-owned palette for seats
    xp.ts                            XP rules (pure): SIGNAL_XP, per-turn caps, applyXpEvent, levelForXp, moodFor
    xpAward.ts                       awardSignal: pays a transcript signal to the roster member, one rosterEvent per award
    memory/                          Memory MCP server (stdio, read-only, bundled to plugin/server/memory-mcp.cjs); imports only core/normalizeProjectPath
      mcpMain.ts                     Entry: readline loop, stdout = protocol only, logs to stderr, drains then exits on stdin end; SIGTERM/EPIPE/orphan exit
      rpc.ts                         JSON-RPC 2.0 dispatcher: initialize, ping, tools/list, tools/call; notifications never answered
      tools.ts                       The four tools: argument checks (bad args = isError, not RPC errors), budgets, envelope, B3 cap ladder, one log line per call
      digest.ts                      What a transcript says: human prompts, ended, commits, PRs, files, test verdicts, cost (tier 1 head/tail, tier 2 full scan)
      reader.ts                      uuid-named lstat-regular transcripts only, O_NOFOLLOW, head/tail reads, streaming scan skipping >1 MiB lines, Budget
      redact.ts                      Redaction table + whole-field fail-closed rule; find_past_work matches the redacted text
      scope.ts                       Project folder from CLAUDE_PROJECT_DIR or cwd (never realpath'd, lstat'd, exact name) + recorded-cwd check; `under` for the all-projects tool
      lastUpdate.ts                  since "last_update": newest sprint-update Skill run followed by a successful clipboard command
      constants.ts                   Every memory limit, cap and fixed string
    dismissalTracker.ts              Unified dismissal state (replaces four legacy globals)
    hookEventHandler.ts              Dispatches normalized AgentEvent into runtime
    hookSubRows.ts                   SubagentStart rows bound to the hook's agent_id (only that sub-agent's Stop ends one)
    subagentWatch.ts                 Shadow store watching sub-agent transcripts (background spawns, workflow agents)
    workflowRuns.ts                  Workflow crews: run journals -> one watched helper per live workflow agent
    httpServer.ts                    Fastify: POST /api/hooks/:providerId, POST /api/statusline/:providerId, GET /api/health, GET /ws, SPA (standalone); SECURITY_HEADERS, token-redacted request log
    usage/usageLimitsBody.ts         Hand-checked body of POST /api/statusline (no Fastify schema: AJV would strip extra keys and coerce types)
    usage/usageLimitsStore.ts        Official 5 h / weekly limits in memory: one sample per window, replaced only by one not older; broadcasts usageLimits
    clientMessageHandler.ts          Single dispatch point for ClientMessage from webview
    server.ts                        Top-level composition
    serverToken.ts                   Standalone token and port across restarts: ~/.pixelmates/server-token (0600, --new-token replaces it) and server-port
    cli.ts                           npx pixelmates entry (npm bin)
    migrateDataDir.ts                One-time copy of layout, roster, state and settings (never the token or hooks, consent stripped) from ~/.pixel-agents when ~/.pixelmates has no config; config.json last, source never written
    fileStateAdapter.ts              Namespaced ~/.pixelmates/ persistence
    configPersistence.ts             { vscode, standalone, externalAssetDirectories, hooksConsent: {providerId: granted|declined}, hooksEnabled: {providerId: boolean} } (absent preference = HookProvider.defaultEnabled, true unless off by default)
    layoutPersistence.ts             ~/.pixelmates/layout.json with atomic tmp+rename
    fileWatcher.ts                   Hybrid fs.watch + 500ms polling, JSONL line buffering, /clear detection
    utf8Boundary.ts                  completeUtf8Length: a read never decodes half a character
    transcriptParser.ts              JSONL parsing for heuristic / file-fallback mode
    timerManager.ts                  Waiting / permission timers
    sessionMeta.ts                   The monitor's `agentSession` (start, branch, short id, cost): per-record fold, head/tail seed, `costFromRecord` (the one cost extractor), scan-adopted folder from the transcript's cwd
    awaitingQuestion.ts              questionText (the one producer of the question text: sanitized, redacted, 80 code points) and the awaiting-state helpers; the text lives in memory only, never logged or persisted
    statusSince.ts                   When each status and pending permission prompt began (the monitor's `since`): stamped on a change, never on a repeat
    assetLoader.ts                   PNG → SpriteData via pngjs
    teamUtils.ts                     isInlineTeammateOf, getInlineTeammates, hasInlineTeammates
    types.ts                         ServerAgentState
    constants.ts                     All timing/scanning constants
  __tests__/                         28 Vitest files
  manual-hook-events.http            Manual hook testing helper (REST-Client format)

adapters/vscode/                     VS Code surface — composes core + server
  extension.ts                       activate() / deactivate()
  PixelAgentsViewProvider.ts         WebviewViewProvider, thin bridge to AgentRuntime
  agentManager.ts                    Terminal lifecycle (claude --session-id <uuid>), restore, persist
  vscodeTerminalAdapter.ts           TerminalAdapter implementation
  uninstall.ts                       vscode:uninstall hook: uninstalls every registered provider (hook entries, status line restore), then factory-resets hooks config
  migrateVsCodeState.ts              One-time legacy state migration (verify-before-clear)
  constants.ts                       VS Code IDs, command names, key names

webview-ui/                          React 19 + Canvas UI (depends only on core/)
  src/
    transport/
      index.ts                       createTransport() — single runtime branching point
      postMessageTransport.ts        VS Code mode (acquireVsCodeApi)
      webSocketTransport.ts          Standalone mode (exponential backoff, send queue, 4001 → rejected)
      reconnect.ts                   Re-sends webviewReady on every reopen (the resync)
      types.ts                       Re-exports MessageTransport from core
    runtime.ts                       isBrowserRuntime detection
    browserMock.ts                   Standalone-browser asset fetch + message injection
    testHooks.ts                     window globals exposed for e2e (officeState, helpers)
    main.tsx                         React entry (StrictMode + createRoot)
    App.tsx                          Composition root (hooks + components + EditActionBar)
    constants.ts                     Webview magic numbers/strings
    notificationSound.ts             Web Audio API chime
    changelogData.ts                 Changelog modal content
    components/                      React UI (toolbars, modals, settings)
      BottomToolbar.tsx, HudCard.tsx, SettingsModal.tsx, InfoModal.tsx,
      Tooltip.tsx, DebugView.tsx, ui/Button.tsx, ...
      limitsPace.ts                  Pure view-model for the official limits (pace, run-out, nudge, colors) behind UsagePanel and HudCard
      MonitorShell.tsx               The window's row [rail][stage][sheet]; the one reader of the monitor version (MonitorRail/MonitorSheet are its slots)
      monitorLayout.ts               Pure: rail width, inline or overlay sheet, full plates, per window size
      MonitorSheet.tsx               The inspector sheet's slot: open while officeState.monitorSheetOpen and an agent is selected (a sub-agent shows its lead), inline from 1600 px, z 45 overlay below (420 px, 380 up to 1440 wide); a deselection closes it, opening it closes Usage; opening and closing report to the App's AutoFit (`setSheet`), which re-fits
      inspector/                     The sheet: inspectorView.ts (pure rows, absent never 0, user text marked pv), sheetInput.ts (OfficeState + App tool rows -> input), sheetControl.ts (openSheet/closeSheet over the keys' setSheetOpen: one switch), InspectorSheet.tsx (reads the rail's Face), PixelArt.tsx + pixelBitmaps.ts (tier gem, icons and the context ring on the medal's grid as crisp SVG rects: the font lacks ✓ ▪ ⌛), inspector.css. A helper row's minutes run from `SubagentCharacter.startedAt`, stamped only for a spawn seen live (after the page's first handshakeDone, outside a resync): the wire carries no helper start
    hooks/
      useExtensionMessages.ts        Message handler — translates ServerMessage into OfficeState mutations
      useNow.ts                      Epoch ms on an interval (the Usage panel's countdowns)
      subagentMessages.ts            subagentToolStart/Present/Done/Clear/Permission and agentToolStart's helper -> helpers (DOM-free, the hook delegates)
      agentMessages.ts               agentToolStart's lead half (row, pose, permission bubble), agentStatus chime, agentTripwire alarm (DOM-free, resync-aware)
      agentListMessages.ts           existingAgents (and the resync window it opens), handshakeDone, agentTeamInfo, agentClosed (DOM-free, the hook delegates)
      layoutLoadedGate.ts            When a layoutLoaded may replace the layout (the editor singleton's unsaved edits, a user import, a resync restating it)
      useEditorActions.ts            Editor state + callbacks
      useEditorKeyboard.ts           Keyboard shortcuts (R, T, Esc, Ctrl+Z/Y)
      introTourState.ts              Intro tour wire-state machine (pure reducer, Node-runner tested)
      useIntroTour.ts                Wires the reducer to React + transport (snapshot, verdict, choices)
      useFrame.ts                    Runs a callback after every drawn canvas frame (the DOM overlays' redraw)
      monitorMessages.ts             The monitor messages and every `since` field -> OfficeState monitor stores (DOM-free)
      useMonitorVersion.ts           Re-renders the monitor panels after a drawn frame that found the stores or the selection changed (pure rule: monitorVersion.ts)
    office/
      types.ts                       OfficeLayout, Character, etc. + re-exports constants
      toolUtils.ts                   STATUS_TO_TOOL mapping, extractToolName (DOM-free; defaultZoom lives in useEditorActions)
      health.ts                      Health labels for the full box and which mark each state draws
      projection.ts                  World→screen math shared by renderer + DOM overlays (mapOffset, overlayProjection, mapRectCss)
      lighting.ts                    Pure light pass: lightingFor(h, m) phases, glowDraws placement, glow cache
      camera.ts                      Pure fit-to-activity: fitView, refitView hysteresis, AutoFit controller
      shadow.ts                      Oval shadow sprites and the shadow/outline/body z order
      nameplate.ts                   plateSide + nameplate box height
      colorize.ts                    Colorize (grayscale→HSL) + Adjust (HSL shift)
      floorTiles.ts                  Floor sprite storage + colorized cache
      wallTiles.ts                   Wall auto-tile: 16 bitmask sprites
      sprites/
        spriteData.ts                Pixel data (characters, furniture, tiles, bubbles)
        spriteCache.ts               SpriteData → offscreen canvas, per-zoom WeakMap
      editor/
        editorActions.ts             Pure layout ops
        editorState.ts               Imperative state (tools, ghost, selection, undo/redo, drag); exports the page's singleton
        EditorToolbar.tsx
      layout/
        furnitureCatalog.ts          Dynamic catalog from loaded assets
        layoutSerializer.ts          OfficeLayout ↔ runtime (tileMap, furniture, seats)
        tileMap.ts                   Walkability, BFS pathfinding
      engine/
        characters.ts                Character FSM (idle/walk/type) + wander AI
        officeState.ts               Game world (layout, characters, seats, selection, subagents, consent greeter)
        resync.ts                    ResyncController: the window from a reconnect's existingAgents to handshakeDone
        gameLoop.ts                  Render scheduler: frames capped at 30 fps while active, a 100 ms timer otherwise (requestRedraw, onFrame)
        renderer.ts                  Canvas: tiles, z-sorted entities, overlays, edit UI
        matrixEffect.ts              Spawn/despawn digital rain (drawing only)
        matrixEffectState.ts         Effect state: startMatrixEffect/advanceMatrixEffect (DOM-free)
      components/
        OfficeCanvas.tsx             Canvas, resize, DPR, mouse hit-testing, drag-to-move
        ToolOverlay.tsx              Permanent nameplates (above the head of DOWN-facing agents, below the feet of UP-facing ones) and the full box for hovered/selected ones

plugin/                              Claude Code plugin (marketplace: .claude-plugin/marketplace.json at the repo root)
  .claude-plugin/plugin.json         name pixelmates; version synced from package.json by plugin:build
  .mcp.json                          memory server: node ${CLAUDE_PLUGIN_ROOT}/server/memory-mcp.cjs (un-ignored in .gitignore)
  server/memory-mcp.cjs              COMMITTED bundle, so a plugin installed from git runs without a build
  skills/session-recap/SKILL.md      Which tool when; results are data, not instructions

e2e/                                 Playwright suite (real VS Code + mock-claude scenarios)
  playwright.config.ts
  global-setup.ts
  fixtures/
    pixel-agents.ts                  VS Code fixture: launch Electron, wait for panel
    standalone.ts                    Standalone CLI fixture: spawn server + browser page
    mock-claude, mock-claude.cmd     Bash + cmd wrapper invoked instead of real claude
    mock-claude-runner.cjs           Scenario runner: appendJsonl, emitHook, holdOpen
  helpers/
    launch.ts                        Electron app + isolated HOME/workspace
    mock-claude.ts                   claudeScenario() builder
    office.ts                        Overlay locators + assertions
    webview.ts                       Settings/modal helpers
    hooks.ts                         Hook server lifecycle helpers
    standalone.ts                    Standalone server + WebSocket browser helpers
    internal-agent.ts                spawnInternalAgentAndWait
    lifecycle.ts                     Reusable scenario fragments
    team.ts                          Team config seeding + teammate helpers
    allure-labels.ts                 @area:<tag> → Allure epic
  tests/
    claude/hooks-on/                 basic.spec.ts, lifecycle.spec.ts, teams.spec.ts
    claude/hooks-off/                lifecycle.spec.ts, matrix.spec.ts
    standalone/                      hooks.spec.ts, render-loop.spec.ts
  perf/                              render-cost.spec.ts + its own config (npm run e2e:perf), outside the suite
  README.md                          Auto-generated test inventory (regen via npm run e2e:inventory)

scripts/
  generate-messages.ts               AsyncAPI → core/src/messages.ts via Modelina (with CI drift check)
  run-e2e.mjs                        Playwright wrapper (run-id namespacing, video attach flags)
  generate-e2e-inventory.mjs         Splices test list into e2e/README.md (CI drift check)
  build-allure-report.mjs            Combine e2e+server+webview Allure results
  assemble-vercel-output.mjs         Stage /reports/allure/ for Vercel deploy
  asset-manager.html                 Unified furniture editor (positions + metadata)
  jsonl-viewer.html                  Standalone JSONL transcript inspector
  wall-tile-editor.html              Wall sprite editor

core/                                npm workspace (no separate package; root manages)
server/                              npm workspace
webview-ui/                          npm workspace
```

## Distribution

Two artifacts from one source tree:

- **VS Code extension** (`.vsix`) — built from source (F5 or `vsce package`), not published. Bundles VS Code adapter + webview SPA + assets + hook scripts.
- **npm package** (`pixelmates`) — `npx pixelmates [--port 3100] [--token <token> | --new-token]` runs the Fastify server and serves the SPA on the same port. Bundles CLI + webview SPA + assets + hook scripts + `core/asyncapi.yaml` (so third-party clients can regenerate from it).

`package.json:files` allowlist controls what ships in the npm tarball and the `.vsix`: `CHANGELOG.md`, `LICENSE`, `dist/cli.js`, `dist/extension.js`, `dist/uninstall.js`, both bundled scripts (`dist/hooks/claude-hook.js`, `dist/hooks/statusline-tee.js`), `dist/assets/`, `dist/webview/`, `icon.png`. `scripts/npm-package-contract.mjs` and `scripts/verify-vsix-package.mjs` fail a package missing either script.

## Communication Flow

Hub-and-spoke. The server is the single aggregation point for all agent activity, regardless of source. The status line wrapper is a third ingress, `POST /api/statusline/:providerId`, for Claude Code's official usage limits only (see Official usage limits).

```
Hook scripts ─POST /api/hooks/:providerId─┐
                                          ├─→ HookProvider.normalizeHookEvent()
JSONL transcripts ─FileWatcher─→ TranscriptParser ┤
                                                   ↓
                                              AgentEvent (canonical)
                                                   ↓
                                              AgentRuntime (dispatch on .kind)
                                                   ↓
                                           AgentStateStore (mutate)
                                                   ↓
                                              StoreEvents → broadcast
                                                   ↓
                          PostMessageTransport ──┤├── WebSocketTransport
                                 (VS Code)      (standalone browser)
```

The VS Code adapter wires `PostMessageTransport` against `acquireVsCodeApi()`. The standalone CLI exposes the same protocol over WebSocket at `/ws` with the webview SPA served from the same Fastify instance. **The protocol shape is identical; only the wire differs.**

Adding a new CLI integration is one subdirectory under `server/src/providers/hook/<id>/`: provider, optional `TeamProvider`, installer, hook scripts. Zero changes to the runtime, the UI, or any existing provider.

## AsyncAPI Protocol Contract

`core/asyncapi.yaml` is the contract. Pinned to **3.0.0** because `@asyncapi/modelina@5.10.1` declares `supportedVersions: ['3.0.0']` only; bumping to 3.1.0 produces `export type Root = any`. Revisit when Modelina ships 3.1.0 support.

- **51 ServerMessage variants** (server → client): agent lifecycle (incl. `handshakeDone`, the end of a standalone handshake's catch-up), agent activity, sub-agent activity (incl. `subagentPresent`), team + context usage + model look (`agentModel`) + session title + session signals (`agentCache`, `agentMode`, `agentShells`) + tripwire (`agentTripwire`, `agentTripwireClear`) + health (`agentHealth`, `agentHealthClear`) + monitor (`agentSession`, `agentArtifacts`, `agentLoop`, `agentTests`, `workflowRun`), roster, assets, settings + workspace, token ledger (`tokenUsage`) + official limits (`usageLimits`), diagnostics.
- **26 ClientMessage variants** (client → server): tripwire ack (`ackTripwire`), lifecycle (`webviewReady`, `launchAgent`, `focusAgent`, `closeAgent`), layout (`saveAgentSeats`, `saveLayout`, `exportLayout`, `importLayout`), settings (`setSoundEnabled`, `setShowModelFlair`, `setCozyLighting`, `setHooksEnabled`, `setWatchAllSessions`, `setAlwaysShowLabels`, `setHooksInfoShown`, `setLastSeenVersion`), discovery + assets, diagnostics.

Both unions use `oneOf` with `discriminator: type`. Every concrete message sets `additionalProperties: false`.

`core/src/messages.ts` is generated by `scripts/generate-messages.ts` invoking `@asyncapi/modelina` with custom constraints (`propertyKey` preserves `type`/`status` field names; `constant` inlines `const` literals). The file has an auto-generation banner. **CI runs `asyncapi:generate` then `git diff --exit-code core/src/messages.ts` — any non-empty diff fails the build.**

## Transport Abstraction

```typescript
export interface MessageTransport {
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): () => void;
  readonly ready: Promise<void>;
  readonly state: TransportState;
  onStateChange(handler: (state: TransportState) => void): () => void;
  onReconnect?(handler: () => void): () => void; // absent on a transport that never reconnects
  dispose(): void;
}
export type TransportState =
  'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'rejected';
```

`PostMessageTransport` reports `connected` for its entire lifetime and has no `onReconnect`. `WebSocketTransport` reconnects with exponential backoff (1 s, doubling, capped at 30 s) and queues sends while disconnected. A close with `WS_CLOSE_UNAUTHORIZED` (4001, `core/src/constants.ts`) is terminal: state `rejected`, no retry, the queue dropped, later sends dropped with one warning, and `ConnectionIndicator` shows "Server token changed. Open the link printed by the CLI." for good (no auto reload). Every other close code retries. The server upgrades the socket before refusing it, so a refused reconnect still counts as an open.

`createTransport()` in `webview-ui/src/transport/index.ts` is the **only branching point** in the UI codebase. Everything downstream uses the `MessageTransport` interface and never knows which transport is active.

### Reconnect resync

A reopen (any open after the page's first) flushes the send queue, then fires `onReconnect`: `transport/reconnect.ts`, installed at module scope in `transport/index.ts`, sets `reconnectState.resyncPending` and sends `webviewReady` again. A first connect keeps the mount-time `webviewReady` as its only handshake (StrictMode's dev-only double is unchanged), a server down at page load included. The `existingAgents` that answers a pending reconnect opens the resync window (`office/engine/resync.ts`); the server's `handshakeDone`, the last message of every standalone handshake's catch-up (only the async hooks status and consent ask follow it; VS Code never sends it), closes it. Leaving `connected` aborts the window, unswept.

- **Agents**: `reconcileExistingAgents(..., { removeMissing: true })` removes top-level agents the list does not hold, with their helpers, at once (`removeAgentImmediate`: no despawn effect, seats freed, selection and camera follow cleared only for them). Kept ids take the server's palette, hue shift, folder and seat when it differs and is free (`applyAgentMeta`; a field the meta omits keeps its value), since after a server restart an id may name another session. Outside a resync the list only adds.
- **Helpers** of kept leads are never recreated. One the server re-announces (`subagentPresent`, or the `runInBackground` `agentToolStart` of its spawn, counted from the reconnect on and forgotten on an abort) keeps its id and seat. At `handshakeDone` an unconfirmed helper that only a resend can vouch for (a `wf:` helper, a teamless lead's background spawn) is removed with no effect and forgotten on the React side; teammates and a teamed lead's background spawns end through their lead.
- **Rows**: sub-tool rows are cleared when the window opens (the resend never carries them). A lead's row the resend restates takes its status; at `handshakeDone` the rows it did not restate go. Outside the window a repeated start leaves its row as it is.
- **Permission**: every tool start the resend restates carries `permissionActive` while the agent's prompt is pending (`agentActivityResend.ts`). Inside the window that flag sets both the bubble and the row's `permissionWait`: a prompt raised while the socket was down shows, one answered meanwhile goes, a pending one stays. A live start without it only clears.
- **Layout**: `layoutLoaded` never replaces unsaved editor changes (the editor singleton in `office/editor/editorState.ts`, read when asked, both runtimes) except a VS Code import (`imported: true`: the user chose it), and in a resync not when it equals, as sorted-key JSON, the last layout this page applied or sent in `saveLayout` (`hooks/layoutLoadedGate.ts`): no rebuild, no checkpoint reset, no seat re-send.
- **Monitor**: `agentSession`, `agentArtifacts`, `agentLoop` and `agentTests` are resent for every agent, the id alone as the clear, and every status, health mark, alarm and pending prompt carries its server `since`. A `workflowRun` the catch-up does not restate goes at `handshakeDone`.
- **Sound and effects**: inside the window helpers appear with no spawn effect, and neither the `agentStatus` chime nor the tripwire alarm plays.
- **Consent**: the webview admits one `hooksConsentRequest` per provider per page load, so a reconnect never replays the Intro.

The standalone server keeps its token in `~/.pixelmates/server-token` (0600, minted on first start, replaced by `--new-token` or by deleting the file; `--token <token>` overrides it for one run without reading or writing the file) and first tries the port it last picked for itself (`server-port`), so the URL the CLI printed survives a restart and an open tab reconnects instead of being refused. The embedded server still mints one per start.

## Provider Abstraction

`HookProvider` (`core/src/provider.ts`) is the integration boundary. Today only Claude Code is implemented; the Claude provider supports every transcript/hook format up to **Claude Code v2.1.220** (current as of 2026-07-30 — Task-era `agent_progress` records, explicit and implicit teams, background-by-default Agent spawns, sidecar-backed background agents). Newer CLI releases may add formats that need provider updates. The interface:

- **Required**: `normalizeHookEvent(raw)` → `{ sessionId, event: AgentEvent } | null`; `installHooks` / `uninstallHooks` / `areHooksInstalled`; `formatToolStatus`; `permissionExemptTools`, `subagentToolNames`, `readingTools` sets.
- **Optional file fallback**: `getSessionDirs(workspace)`, `getAllSessionRoots()`, `sessionFilePattern`, `parseTranscriptLine(line)`, `buildLaunchCommand(sessionId, cwd, opts)`. Used when hooks aren't installed.
- **Optional team extension**: `team?: TeamProvider` for Lead + Teammates support.
- **Optional XP signals**: `toolVerdicts(name, input)` at a tool_use and `resultSignals(verdicts, record)` at its single tool_result. Only verdicts and hashed keys leave the provider. A provider without both earns no XP.
- **Optional monitor facts**: `extractArtifact(call, result)` (a page publish; reads, lists, asset uploads, created-from-type pages and failed calls are `undefined`) and `extractLoop(record)` (`schedule` / `stop` / `fire`). Test counts come from the provider's `turnTraits.shellTools` results through `parseTestSummary`.
- **Optional default**: `defaultEnabled` (absent = true). An off-by-default provider (the status line wrapper) is never asked about at startup; only a Settings toggle-on asks.
- **Optional liveness**: `liveness(sessionIds)` → `Promise<Map<sessionId, 'alive' | 'dead' | 'unknown'>>`. `unknown` (no evidence) never reads dead. Without it no agent is ever dead.
- **Turn traits** (`turnTraits`): `longRunningTools`, `userQuestionTools`, and for health `shellTools`, `editTools`, `userInputTools`. The runtime classifies tools only through these sets.

`AgentEvent.kind` values: `toolStart`, `toolEnd`, `turnEnd`, `subagentStart`, `subagentEnd`, `subagentTurnEnd`, `progress`, `permissionRequest`, `sessionStart`, `sessionEnd`. The runtime dispatches on `kind`, never on CLI-specific tool names.

### TeamProvider (Lead + Teammates)

Optional extension for CLIs that support team workflows (Claude Agent Teams today). Semantic queries (`discoverTeammates`, `getTeamMembers`, `getTeamMetadataForSession`, `extractTeammateNameFromEvent`, `isTeammateSpawnCall`) — providers choose their own storage strategy.

Four teammate modes:

| Mode                            | Trigger                                          | Detection                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic subagent (teams OFF)      | `Task(...)` or `Agent(run_in_background: false)` | `subagentStart` with team gate not matched, or JSONL `agent_progress`                                                                                                                                                                                                                                                                                                                   |
| Inline teammate (teams ON)      | `Agent(run_in_background: true)` in-process      | `onTeammateDetected` → `discoverTeammates(projectDir, leadSessionId)`                                                                                                                                                                                                                                                                                                                   |
| Session teammate (teams + tmux) | `Agent(run_in_background: true)` in tmux pane    | Own session, own hooks, routes through normal flow                                                                                                                                                                                                                                                                                                                                      |
| Implicit-team agent (Claude 5)  | `Agent(...)` — background by default, NO flag    | Lead-side: spawn tool_result `agent_id: <name>@<team>` → `extractTeammateSpawnFromToolResult` sets lead `teamName`; teammate = own top-level UUID session tagged `teamName`/`agentName` on every record, discovered by `discoverTeammates(projectDir, leadSessionId, teamName)` and fast-attached in `onExternalSessionDetected` (bypasses the Watch All gate when the lead is tracked) |

Newer harnesses (Claude 5) never tag the LEAD's records with team metadata and never write `agent_progress`/`queue-operation` records for these spawns — the spawn tool_result and the teammate's own session (own JSONL, own hooks) are the only signals. The implicit team writes `~/.claude/teams/session-<8hex>/config.json` (its `leadSessionId` matches no transcript on disk — don't link by it). Own-session teammates are registered with the SessionRouter (`setTeammateRegisterCallback`) so their hooks route directly to them.

**Team generations on resume (last-wins latch)**: every CLI run of a session mints a FRESH implicit team, so a resumed lead's transcript carries spawn tool_results from several `session-<8hex>` generations. A tag-less lead re-latches to the newest spawn's team (`setTeamSwitchCallback` removes the defunct team's teammates); tag-derived identity (`teamNameFromTags`, set by the record-tags branch) is authoritative and never overwritten by spawn results. `linkTeammates` never badges a named teammate as LEAD — if only teammates are tracked, linking waits until the real lead is detected (prevents a phantom LEAD character when a teammate session is adopted before/without its lead). Restore drops `isTeamLead` from persisted agents that carry an `agentName`.

**Background spawns without a CLI team (sidecar-backed)**: `Agent(...)` spawns that never register a team take the async path — result "Async agent launched successfully. agentId: \<hex>" (no team anywhere), transcript + sidecar under `<projectDir>/<leadSessionId>/subagents/` (sidecar carries `agentType`/`description`/`toolUseId`, plus `name` when the spawn was named), completion via `queue-operation`. `scanForBackgroundAgentFiles` classifies them by the sidecar `name` — the domain model's sole Sub-agent vs Teammate distinction (see CONTEXT.md):

- **Named → Teammate**: its own seated character, `agentName` from the sidecar `name`; the spawner gets `isTeamLead` + an `agentTeamInfo` broadcast (derived team — NO `teamName`, so config polling stays away) and the transient Subtask is ghost-killed via `subagentClear`. The child has `leadAgentId` + `spawnToolUseId`; it's removed on the completion queue-operation or lead sessionEnd (`removeTeammate` must NOT unregister its session — it shares the lead's).
- **Unnamed → Sub-agent**: the Subtask sub-character stays; the spawn's transcript is watched in a **shadow `AgentStateStore`** (`server/src/subagentWatch.ts`, owned by `AgentRuntime`, ids from 1 000 000 up) whose broadcasts are translated onto the main store as `subagentToolStart/Done/Permission` keyed `(leadId, spawnToolUseId)` — live activity on the sub-character, no protocol change. `agentToolsClear` on the shadow agent synthesizes `subagentToolDone` for still-live tools so the sub idles between turns. Never persisted, never announced.

The gate for both: the sidecar `toolUseId` must match a LIVE entry in the lead's `backgroundAgentToolIds` (anti-spurious; no teamName involved). `scanForTeammateFiles` skips sidecars carrying a live `toolUseId` so it can't race the classification. The lead's `backgroundAgentToolIds` are persisted (children never are — they're derived state the 1 s scan re-materializes after a reload; restore skips stale entries with `leadAgentId` but no `teamName`). The turn-end background-tool re-sends (transcriptParser, hookEventHandler, timerManager's `clearAgentActivity`) must include `toolName` + `runInBackground` (or the webview can't recreate the Subtask after `agentToolsClear`) and must skip tools whose spawn became a teammate character (`hasPromotedBackgroundAgent`, or a ghost Subtask appears next to it).

**Workflow crews (`server/src/workflowRuns.ts`)**: the Workflow tool runs a script whose agents write under `<projectDir>/<leadSessionId>/subagents/workflows/wf_<runId>/`: `journal.jsonl` (`started {agentId, label, phase}` / `result {agentId}`, appended only at start and result) and `agent-<id>.jsonl` (sidechain records on the lead's sessionId). Sidecars there carry no `toolUseId` and an unreliable shape: never read. Each live agent is watched in the SubagentWatch shadow store under the synthetic parent tool id `wf:<runId>:<agentId>` (`WORKFLOW_PARENT_TOOL_ID_PREFIX`), so the webview draws one helper per agent. Rules:

- **Discovery** runs per lead from `scanAllTeammateFiles`, before the teamName gate, never through `discoverTeammates` (a teamed lead would adopt workflow agents as teammates named after their agentType). A launch result kicks a scan via `setImmediate`, after the current batch of lines, so a launch and its completion read together never flash helpers. Per tick: one readdir of `workflows/` (a missing dir is re-checked every 5 s, a launch result resets that), a journal stat per tracked run with an incremental read only when its size changed, one transcript stat per started-not-finished agent (every 10 s once stale).
- **Journal reads** consume bytes only through the last newline (a half-written line waits for the next tick); invalid or unknown lines are skipped. They go in `WORKFLOW_JOURNAL_CHUNK_BYTES` (1 MiB) chunks, all within one scan, so memory stays bounded by a chunk plus one line (result lines carry an agent's whole output); a line over `WORKFLOW_JOURNAL_MAX_LINE_BYTES` (4 MiB) is consumed unparsed. `started`, `finished` and `completed` are sticky: a shorter journal is re-read from 0 and a replayed line changes nothing. All journals are read before the live set is computed, so an agent whose started and result land in one tick is never watched.
- **Live** = started, not finished, run not completed, transcript on disk (never a watch on a missing path) and moved within `WORKFLOW_AGENT_STALE_MS` (15 min; a missing transcript runs on the clock of its started line). Stale agents are torn down but stay candidates: a transcript that moves again brings the helper back under the same key. The live set is diffed against the lead's `watched` set; `SubagentWatch.watch()` is idempotent per (lead, spawn id) and `removeBySpawn` removes every match. The only teardown path is `endWorkflowAgent` (`removeBySpawn` + `subagentClear`).
- **Age**: `WORKFLOW_RUN_MAX_AGE_MS` (2 h) gates adoption only, against the newest of the journal and the agent transcripts (a server started mid-run still adopts a long agent); rejected dirs are re-checked every 60 s. A tracked run with nobody live is forgotten only once that same test would reject it (looked at every 60 s), and it then joins the rejected dirs: dropped on its journal's age alone, a killed run whose transcript is newer would be adopted again the next tick, its completion forgotten.
- **Run end**: the lead's Workflow `tool_result` carries `toolUseResult {taskType: 'local_workflow', runId: 'wf_<id>', status, transcriptDir}`; the canonical runId drops the `wf_` prefix and must match the transcriptDir name. `async_launched` maps the tool id to the run; any other status is a foreground run that already finished. The lead's `queue-operation` task-notification for a mapped tool id ends the run whatever its status. Completion reads the journal first (lines already written must not pass for a resume), then tears every helper of the run down; a completion that lands before discovery is remembered and the run is adopted completed. New `started` agents in a completed run's journal reopen it (a resume reusing `wf_<runId>`); late result lines never do. The tool -> run map and the completed run ids are persisted on the lead (`workflowRuns`, `completedWorkflowRunIds`, both writers and both restorers) and pruned with the run dirs. Lead removal (sessionEnd or `removeAgent`) disposes the whole state. A lead whose session ended but that stays (a terminal agent) is not scanned while it is still on that session; a Workflow launch there (a resume keeps the session id) scans again with that session's runs taken as completed, since a rebuilt state would not know which of them were killed.
- **Hooks with `agent_id`** belong to a sub-agent, Task/Agent or workflow alike. Tool calls still run tripwires and feed the mood (never XP) but never start, end or fail a lead tool or move its status; a sub-agent's permission prompt shows on the lead (PermissionRequest carries its `agent_id`, Notification does not) and its next tool call clears it with `agentToolPermissionClear`, since no lead tool start does; an `agent_id` event never confirms, buffers or adopts an unknown session; Stop/SessionStart/SessionEnd/UserPromptSubmit/PreCompact carrying `agent_id` are dropped in `normalizeHookEvent` (Notification keeps its path). SubagentStart of a known workflow agent draws no row; hook rows are bound to their `agent_id` (`hookSubRows.ts`) and a SubagentStop releases only its own row (no row: no-op), so it never clears another sub-agent's helper; a journal `started` releases the row its agent drew before the journal was read. That the hook `agent_id` equals the journal `agentId` is unverified on real hook traffic.
- **Protocol**: `SubagentToolStart` has optional `label` (60) and `group` (40, the journal phase), sent on EVERY start of a workflow agent (the webview recreates helpers lazily after a reconnect) and omitted for every other sub-agent. `subagentPresent {id, parentToolId, label?, group?}` announces a workflow agent the moment its watch attaches (once per attach, again after a stale agent moves) and on every handshake (`webviewReady` -> `resendAgentActivity`, i.e. a page load, a panel reload or a standalone reconnect): a helper otherwise shows only on a tool call the stream reads, never for an agent that only thinks, nor for one tailed past its earlier tools. A helper announced before its lead reaches the webview (a broadcast between the socket's connect and the handshake) is re-placed and given the lead's look when the lead is added. A standalone socket that reconnects re-runs the handshake (see Reconnect resync): a watched agent's helper stays put, and one whose agent ended while the socket was down goes at `handshakeDone`, with no effect. Runs of whitespace, control and format characters (bidi overrides and isolates, zero-width marks) become one space, then both are cut by code points; they are user script text: never logged, never persisted.
- **Run view**: every tracked run has a `workflowRun` view (`status`, `name`, `phases`, `started`, `done`, `since`), rebuilt from the sticky journal state after each scan and each completion and broadcast only when it changed; a dropped run or an ended session sends the clear (`id` + `runId`). Counts come from `started`/`finished`, never from live helpers, so they survive teardown and a resume's reopening; phases are the journal `phase` in first-seen order (32 at most), counted per phase. `name` (the launch result's `toolUseResult.workflowName`, label rule, 60 code points) and `since` (when this process first saw the launch) live in memory on `LeadWorkflowState.launches`: never logged, never persisted, so both are absent after a restart. A count is sent only once an agent started (absent is never 0). `workflowPresenceMessages` replays each run's last view at every handshake.
- **Ledger**: `claudeUsage.ts` also reads `subagents/workflows/wf_*/agent-*.jsonl` (one level); the records carry the lead's sessionId, so they count to the lead.

Teammate dismissal is driven by team config polling (`getTeamMembers(teamName)` is authoritative; members with `isActive: false` are treated as departed), by the teammate's own `sessionEnd` (own-session teammates), and by `sessionEnd` on the lead.

**Subtle gate (the one that bit us recently)**: in `webview-ui/src/hooks/subagentMessages.ts` (`applyToolStartHelper`, the helper half of `agentToolStart`), `agentToolStart` with `runInBackground=true` only creates a Subtask sub-character when the **parent has no `teamName`**. With a team, `onTeammateDetected` creates the teammate instead (and the gate prevents a ghost sub-agent). Without a team, the teammate path never fires and the basic Subtask sub-character is the only visible representation. The gate's blind spot — a TEAMED lead's unnamed background spawn — is covered by `subagentToolStart` creating the sub-character lazily when it's missing (`addSubagent` is idempotent); the same lazy path recreates subs after a panel reload.

## Server Runtime

`AgentRuntime` (`server/src/agentRuntime.ts`) is the shared lifecycle core. Both surfaces (`adapters/vscode/PixelAgentsViewProvider.ts` and `server/src/cli.ts`) compose the same runtime; only the `StateAdapter` namespace, `MessageTransport`, and `TerminalAdapter` differ.

```typescript
export class AgentRuntime {
  constructor(opts: {
    store: AgentStateStore;
    providerRegistry: ProviderRegistry;
    layoutPersistence: LayoutPersistence;
    assetCache: AssetCache;
    config: Pick<AdapterSettings, 'hooksEnabled' | 'watchAllSessions'>;
    terminalAdapter?: TerminalAdapter;
    callbacks: RuntimeLifecycleCallbacks;
  });
  registerAgent / unregisterAgent / removeAgent / removeTeammate / removeTeammates
  restoreExternalAgents / handleHookEvent
  startProjectScan / startExternalScanning / startStaleCheck
  dispose();
}
```

Owns timer Maps (waiting, permission, text-idle, stale), scanners (project-dir 1 s, external 3 s, stale 30 s), the health tick (30 s, both hooks modes), `HookEventHandler`, `SessionRouter`, `DismissalTracker`. Scanners are skipped entirely while hooks are flowing (`hookDelivered` is set on every agent). `RuntimeLifecycleCallbacks` is the only seam between runtime and host.

### AgentStateStore

EventEmitter-backed container in `server/src/agentStateStore.ts`. Typed mutations, typed events (`agentAdded`, `agentRemoved`, `agentUpdated`, `broadcast`). The broadcast layer subscribes once at boot and translates `StoreEvents` into `ServerMessage` over the active transport. **No module under `server/` calls a transport method directly.**

### SessionRouter and DismissalTracker

Two extracted classes that replaced ad-hoc module state. `SessionRouter` owns `session_id → agent_id` mapping, pre-registration event buffering, and pending external sessions. `DismissalTracker` unifies four legacy globals (`dismissedJsonlFiles`, `clearDismissedFiles`, `seededMtimes`, `pendingClearFiles`) into one class with typed reasons.

### HTTP + WebSocket Server

Fastify v5 with `@fastify/websocket`, and (in standalone) `@fastify/static`:

| Method | Path                          | Purpose                                                                                                                                               |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/hooks/:providerId`      | Bearer-authenticated hook event ingress (1 MiB body, token checked before the body is read)                                                           |
| POST   | `/api/statusline/:providerId` | Bearer-authenticated official usage limits from the status line wrapper (token checked before the body is read); 400 for anything but the two windows |
| GET    | `/api/health`                 | Liveness: `{ status: 'ok', uptime, pid }`                                                                                                             |
| GET    | `/ws`                         | Bidirectional protocol channel                                                                                                                        |
| GET    | `/*` (standalone only)        | Webview SPA via `@fastify/static`                                                                                                                     |

Every reply carries `SECURITY_HEADERS` (`httpServer.ts`): a `Content-Security-Policy` that admits only the SPA's own bundle, styles, fonts, images and same-host socket (`connect-src 'self'`, which CSP3 matches against `ws:` on the page's host and port), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. One root `onSend` hook sets them on any bind and in both modes (`httpServerHeaders.test.ts`). no-referrer keeps the page's `?token=` out of every Referer. The standalone e2e fixture runs the real SPA under them: teardown fails on any policy refusal, requires frames on the `ws://127.0.0.1` `/ws?token=` socket, and ends with an inline-script probe that must be refused. Fastify answers a url it cannot decode with its own 400 before any hook runs, so that JSON reply carries none of them.

`/ws` is gated in **two tiers**, because `setHooksEnabled(true)` over this socket is a durable, machine-wide consent grant plus a hook install.

1. **Connection**: embedded requires the Bearer token; standalone requires a same-origin handshake (`isAllowedWebSocketOrigin`) AND the `?token=` (`standaloneTokenValid`), because the broadcast stream itself carries tool activity. On a loopback bind an `onRequest` hook also refuses any `Host` that is not a loopback name, so a DNS-rebound page (`Origin` and `Host` both `evil.com`) gets 403 on every route (`httpServerWs.test.ts` pins both).
2. **Privileged messages** (`standaloneTokenValid`, `ClientMessageContext.privileged`): proved by an out-of-band secret — embedded via its Bearer token, standalone via the server token in the `/ws` `?token=` query, which the CLI prints in the local URL and the SPA forwards (`webview-ui/src/transport/index.ts`). **Never a network position**: peer address, `Host` and `Origin` all ride the channel a proxy speaks, so a LAN-bound forwarder piping bytes to 127.0.0.1 satisfies all three. The token is a replayable bearer capability, not evidence of locality — it also reaches browser history, so the printed URL is documented to the user as a secret. It outlives restarts (`~/.pixelmates/server-token`, see Reconnect resync), so rotating it means `--new-token` (or deleting that file). Since every accepted standalone socket carries it, `privileged` is always true there. The request log shows `token=[redacted]` in every url, including the `path` @fastify/websocket logs when it closes an upgrade on a route with no ws handler, and never logs `Authorization` (`redactedRequestSerializer`, `redactTokenParam`, pino `redact`); our own not-found handler replaces Fastify's default one, which logged the raw url.

The **hooks preference is persisted only after the install/uninstall settled and the on-disk result agrees** — writing it first strands the user when an uninstall fails: entries still firing, but a persisted hooks-off makes the next startup skip the consent/install path entirely.

Server discovery written to `~/.pixelmates/server.json` with `{ port, pid, token, startedAt, servesSpa, protocol }`. Multi-window safe: a second server detects an existing `server.json` and reuses or replaces it based on PID liveness.

**Standalone token and port** (`serverToken.ts`): the token in `~/.pixelmates/server-token` (see Reconnect resync) and the port in `server-port`, a plain integer from 1024 to 65535 (anything else is ignored). Both are written 0600 by one tmp+rename writer and never deleted by `stop()`. Embedded never reads or writes either: its token must not become, or replace, the long-lived one. A live standalone found in the registry is reused as before and both files are left alone. `--new-token` mints a token and saves it over the old one only once the server listens, so a failed start revokes nothing; next to `--token` it is refused, and against a live standalone it is ignored with one stderr line. Without `--port` the saved port is tried first; if it is taken (`EADDRINUSE`, or `EACCES` from a Windows excluded port range) the server retries once on an OS-assigned port and keeps the saved one for the next start. Only a port the server picked itself is saved: an explicit `--port` serves that run only, so test and e2e runs, which always pass one, never move a user's port (every harness that starts the CLI's server also gives it a temp `HOME` and `USERPROFILE`). The CLI shuts down on `SIGHUP` like on `SIGINT`/`SIGTERM`, so a closed terminal still removes `server.json`.

### ClientMessageHandler

The standalone dispatch point for `ClientMessage` (every `/ws` socket). Each variant calls into `AgentRuntime`, `AgentStateStore`, `LayoutPersistence`, or `FileStateAdapter`, or delegates to host-specific callbacks (`onLaunchAgent`, `onOpenSessionsFolder`, `onExportLayout`, `onImportLayout`, `onSetHooksEnabled`). VS Code never calls it: `PixelAgentsViewProvider` dispatches its webview's messages itself, so a rule both surfaces must share (the consent gate, the toggle's ask-first rule) lives in `server/src/providers/hook/` and each dispatch calls it.

### ServerAgentState (server/src/types.ts)

Per-agent runtime data: provider reference, session key, transcript-fallback fields (`jsonlFile`, `fileOffset`, `lineBuffer`), tool state Maps and Sets, team fields (`teamName`, `agentName`, `isTeamLead`, `leadAgentId`, `teamUsesTmux`), context usage (`contextTokens`, `maxContextTokens`, `sawMainChainUsage`), session signals (`cacheTtlSeconds`, `cacheExpiresAt`, `cacheMessageId`, `permissionMode`, `runningShellIds`, `shellDoneBeforeLaunch`; all optional, none persisted), and the **`hookDelivered`** flag that suppresses heuristic timers when hooks are flowing.

## Persistence

```
~/.pixelmates/
  config.json              { vscode, standalone, externalAssetDirectories, hooksConsent, hooksEnabled (both per-provider) }
  vscode-state.json        { agents, seats }
  standalone-state.json    { agents, seats }
  layout.json              OfficeLayout (shared across surfaces)
  roster.json              { version, members (xp, streak, consecutiveFailures, lastFolder), holds } shared by both surfaces
  server.json              { port, pid, token, startedAt, servesSpa, protocol }
  server-token             Standalone server token (0600), reused across restarts; not read or written with --token, replaced by --new-token
  server-port              Port the standalone server last picked for itself, tried first on the next start; not read or written with --port
  hooks/claude-hook.js     Bundled hook script (CJS, shebang)
  hooks/statusline-tee.js  Bundled status line wrapper; kept on uninstall, so a wrapper still in statusLine keeps running the user's command
```

`FileStateAdapter({ namespace })` backs both runtimes. Per-namespace settings: `soundEnabled`, `lastSeenVersion`, `alwaysShowLabels` (no longer read by the UI: nameplates are permanent), `cozyLighting`, `watchAllSessions`, `hooksInfoShown` (the hooks preference is per-provider and machine-global, at the config top level). Running both surfaces in parallel never clobbers either.

`migrateVsCodeState` (VS Code adapter only) walks each known legacy key once with **verify-before-clear** semantics: write to file, read back, only then clear the legacy key. While anything remains unmigrated, activation shows a non-blocking warning.

Layout writes are atomic via tmp + rename. Cross-window watching is hybrid (`fs.watch` + 2 s polling). `markOwnWrite()` prevents the watcher from re-reading our own write.

## Agent Status Tracking

JSONL transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Project hash = workspace path with `:`/`\`/`/` → `-`.

**JSONL record types**: `assistant` (tool_use or thinking), `user` (tool_result or text prompt), `system` with `subtype: "turn_duration"` (reliable turn-end signal), `progress` with `data.type`: `agent_progress` (sub-agent tool_use/tool_result, non-exempt tools trigger permission timers), `bash_progress` (Bash output: restarts permission timer), `mcp_progress` (MCP tool: same timer restart), `queue-operation` with `operation: enqueue` (task notifications: end background agents, workflow runs and background shells), `attachment` with `attachment.type: queued_command` (a prompt queued while the agent was busy; a task notification there, or as a `user` text prompt, also ends a background shell), `permission-mode` (the permission mode, also stamped on every `user` record). Also observed but not tracked: `file-history-snapshot`, `mode` (the CLI's input mode, `normal`), other `queue-operation`s and `attachment`s.

**File watching**: 500 ms polling with partial-line buffering for mid-write reads. A read that ends inside a multibyte UTF-8 character (the 64 KiB chunk cap, or a writer paused mid-character) decodes only whole characters and leaves the rest behind `fileOffset` (`completeUtf8Length`, `utf8Boundary.ts`); `readNewLines` does it for every watched agent, sub-agent shadows included, and the turn-state seed for the tail it reads. No loop or wait may run on `fileOffset < size`: a file that ends mid-character keeps up to 3 bytes unread, so a replayed history's health catch-up ends at a read that reached the end. Tool-done messages delayed 300 ms to prevent React batching from hiding brief active states.

### Dual-mode detection

| Mode                     | Source                                                 | Detection                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hooks** (preferred)    | Claude Code Hooks API → HTTP POST → `HookEventHandler` | Instant, reliable. Installed events are `CLAUDE_HOOK_EVENTS`. `UserPromptSubmit`/`TaskCreated` are deliberately NOT installed — they normalize to null, so installing them only forwarded prompt text to be dropped; `normalizeHookEvent` still tolerates them for stale installs |
| **Heuristic** (fallback) | Polling JSONL files                                    | Per-agent 500 ms JSONL polling for /clear detection; 1 s main scanner for terminal adoption; 3 s external scanner; 30 s stale check. Content-based /clear detection (`/clear</command-name>` in first 8 KB)                                                                       |

The `hookDelivered` flag (per agent) and `hooksEnabled` (global) gate timer logic. JSONL polling always runs in both modes for tool content (status text, animations); only permission (7 s) and text-idle (5 s) timers are suppressed by `hookDelivered`.

### Sub-agent permission detection (heuristic)

When a sub-agent runs a non-exempt tool, `startPermissionTimer` fires on the parent agent. If `PERMISSION_TIMER_DELAY_MS` (7 s) elapses with no data, permission bubbles appear on both parent and sub-agent characters via `agentToolPermission` + `subagentToolPermission` broadcasts.

`activeSubagentToolNames: Map<parentToolId, Map<subToolId, toolName>>` tracks which sub-tools are active for the exempt check. Cleared when data resumes, Task completes, or `turn_duration` arrives.

**Timing budget for tests**: the test waits for the bubble AFTER waiting for the "Subtask:" overlay. But the Subtask overlay appears when the parent's **Task tool_use** is parsed (scenario time T), while the timer only starts when the **sub-tool tool_use** in the progress record is parsed (~1 s later). Plus 7 s timer + 300 ms IPC/render slop = a wait timeout less than ~10 s is unsafe.

### Context usage (server/src/contextUsage.ts)

Every agent's context gauge. Fed from `message.usage` on assistant records by `processTranscriptLine`, broadcast as `agentContextUsage` and rendered by `ToolOverlay`.

- **Snapshot, not a total.** Context = the newest turn's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`. Summing turns measures spend, not occupancy, and misses the cached tokens that ARE the context (`input_tokens` is single digits once caching kicks in). Falls on compaction and `/clear` for free.
- **All-zero usage means "no news"** — synthetic records (API errors, interrupts) report zeros and must not blank the gauge.
- **Sidechain rule**: a lead's sidechain records are its sub-agents' turns and must not move its gauge; a teammate's own transcript is sidechain top to bottom and would otherwise never report. Positional latch (`sawMainChainUsage`): once a file produces a main-chain turn, later sidechain records belong to someone else.
- **The window comes from the provider**, not from the runtime: `HookProvider.contextWindowForModel(model)` (Claude: 1M for the current line, 200k for Haiku and the older models, `undefined` for ids it can't place). Transcripts state usage but never the limit, and guessing 200k for a 1M model reads five times too full. `widenContextWindow` is the backstop for unrecognized models and unknown-larger windows — it only ever widens, since a context that doesn't fit disproves the assumption while a shrinking one proves nothing.
- **`seedContextUsage` runs once per agent in `startFileWatching`** — the single seam every watched agent passes through. Agents adopted or restored mid-session start at end-of-file, so without a tail read they'd have no gauge until their next turn.
- The same tail read seeds the prompt-cache clock (see Session signals).
- Sub-agents get no gauge: no session of their own, and the shadow store never forwards `agentContextUsage`.

### Session title (server/src/sessionTitle.ts)

The character label shows the session title instead of the folder when one is known. Claude Code writes `custom-title` (from `/rename`) and `ai-title` (generated) records throughout the transcript; `HookProvider.extractSessionTitle` reads them, `applySessionTitle` keeps both on the agent and broadcasts `agentSessionTitle` only when the derived title (`customTitle ?? aiTitle`) changes.

- **Absent means fall back, never blank.** Only non-empty trimmed strings count (capped at `SESSION_TITLE_MAX_LENGTH`); `title` is omitted from the message when an agent has none, and the webview (`agentLabel`) then shows the folder.
- **`seedSessionTitle` runs in `startFileWatching`**, next to `seedContextUsage`, for agents that start at end-of-file. It also drops titles read from a different `jsonlFile` (switch, `/clear`) and broadcasts the clear. At `fileOffset === 0` it leaves the titles to the live replay. A restore with a mid-file offset may briefly show an older title while replay catches up.
- `resendAgentActivity` sends the message for every agent on reconnect, with `title` omitted for untitled ones, so a client that missed a clear does not keep a stale title.
- Titles come from user prompts: never log their text.

### Session signals (server/src/sessionSignals.ts, cache clock in server/src/contextUsage.ts)

Three things Claude Code's statusline shows, made real per agent end to end: `agentCache` ("cache 59m left"), `agentMode` ("auto mode on"), `agentShells` ("3 shells"). Transcript only: hooks carry none of them sooner (UserPromptSubmit is not installed).

- **Cache clock is an estimate.** The official `prompt_cache` reaches only the statusline's stdin, never hooks or transcripts. The clock starts at the first transcript line of the turn instead of the request, so it trails by seconds, never by a TTL class. TTL: 3600 when `usage.cache_creation.ephemeral_1h_input_tokens > 0`, else 300 when `ephemeral_5m_input_tokens > 0`, else the previous TTL (a read has no TTL); none known yet means no message. The newest write wins, no latch: a 5m write after 1h ones is the move to usage credits. `expiresAt` = record timestamp (`recordTimestampMs`, the same parse the Claude `turnSignal` uses) + TTL; a record without a parseable timestamp never moves it (no `Date.now()` fallback, it would date seeded turns to the read).
- **Same records and gates as the gauge**: only what `updateContextUsage` accepts (all-zero gate, sidechain latch), one broadcast per `message.id` (`cacheMessageId`; a message spans 2-6 lines with later timestamps). `seedContextUsage` seeds the gauge and the clock apart: the clock replays the tail's main-chain usage records through the live rule whenever `cacheExpiresAt` is unknown, so an agent with a gauge (a reassign) still gets one. No write in the tail is unknown, never cold.
- **Cold is the reader's call**: the server sends `expiresAt` once per turn, never ticks; the webview derives minutes left and cold from it against the machine clock on every frame.
- **Mode**: `HookProvider.extractPermissionMode` (Claude: `permission-mode` records and `permissionMode` on user records, passed raw); `applyPermissionMode` keeps only the six protocol modes and broadcasts on change (most records repeat it). `seedPermissionMode` runs in `startFileWatching` beside the title seed: newest carrier in the tail, skipped at `fileOffset === 0`; a tail without one leaves a known mode alone. The mode is the CLI process's: it survives `/clear` and resume.
- **Shells**: a launch counts on its tool_result, never the tool_use: main-chain Bash whose `toolUseResult.backgroundTaskId` is a non-empty string (a denied launch has a result without one; auto-backgrounded commands carry it with no `run_in_background`). It ends on its task notification for its tool-use id, whatever the status, in any of three copies: the enqueue, and the `user` text prompt and `queued_command` attachment that deliver it to the model (18 of 1002 real launches had only one of those two). A stopped shell never gets one (59 of 59 real stops): the TaskStop result ends it by the `task_id` it names, read from the result, which `runningShellIds` maps back to the launch. Unknown ids never count down (sub-agent shells finish on the lead's file). An enqueue for one goes to a memo capped at `SHELL_DONE_MEMO_MAX`, because it can land before its launch's result (2 of 1002 real launches), and that launch then never counts; the delivered copies always land after the result and mostly repeat an enqueue, so they only delete. Bash never enters `backgroundAgentToolIds` and leaves the `activeTool*` maps on its result like any tool. Not persisted, not seeded: a restart reads 0 until the next launch.
- **Clear form** (`resetSessionSignals`): `reassignAgentToFile` (`/clear`, resume) drops the clock and the shells and broadcasts `agentCache {id}` + `agentShells {id, running: 0}` before the new file's seed, and keeps the mode without a message. `handleSessionEnd` does the same for a terminal agent (`!isExternal`, which stays in the office) on every reason, and also clears the mode when the reason is not clear/resume. In hooks-off mode nothing ends a session, so shells live until `/clear` or removal.
- **Resend**: all three for every agent after `agentSessionTitle`, unknown fields omitted and `running: 0` when none. Shadow (sub-agent) stores compute them but `subagentWatch.translate()` drops them.
- **Webview**: `cacheByAgent`, `modeByAgent`, `shellsByAgent` on `OfficeState`, keyed by id (they can precede `agentCreated`), cleared by `removeAgent`; an omitted field deletes the entry. The full box adds `cache`, `mode`, `shells` rows after the model row (`fullBoxRows`, lifted by `fullBoxTopOffsetPx`); none on sub-agents, no cache row below `CACHE_ROW_MIN_CONTEXT_TOKENS` (20k), no mode row for `default`.
- **Known gaps**: a teammate's transcript is sidechain top to bottom, so its shells never count and its clock is never seeded (the live path still moves it).
- **Handoff**: when the official-limits piece lands `agentStatusline`, its cache row wins while its data is fresh (received within 90 s; the statusline refreshes every 30 s) and falls back to `cacheByAgent` otherwise. On both sides cold derives from `expires_at` vs now, never from `warm`, which can be stale. `cacheByAgent` keeps its name and shape for that piece.

### Session meta (server/src/sessionMeta.ts)

`agentSession {startedAt, branch, sessionId8, costUsd, costAt}`, every field optional and absent until known (a real 0 only when a `cost-state` said 0). `HookProvider.extractSessionMeta` (Claude: `timestamp`, `gitBranch`, `cwd`, `cost-state.totalCostUSD`) feeds one fold; `applySessionMeta` runs it per record at the transcriptParser seam and broadcasts only when a field changed. The shown view lives on `AgentState.sessionMeta` (the resend spreads it); the fold's own state is `sessionMetaTrack`, tied to one `jsonlFile`.

- **Start** = the first record with a parseable timestamp in the file's head (first 256 KiB, the cut line dropped; none found = absent). Line 1 is usually a metadata row without one. A resume writes a new file with copied older records, so this is the start of the transcript, not of the work. A file empty at the seed takes its first live record.
- **Branch**: last record wins, flattened and cut at 120 code points (`sanitizeWorkflowText`). User text: never logged.
- **Cost**: `cost-state.totalCostUSD` is one CLI process's counter and restarts on resume, so the total is the sum of every process's last value (a drop starts a new process; equal repeats change nothing). The rows carry no timestamp: `costAt` is the newest record timestamp folded before the row. `costFromRecord(track, record, provider)` is the one extractor for the live path, the adoption tail and any history scan; call it on every record in order.
- **Seed** (`seedSessionMeta`, in `startFileWatching`, once per `jsonlFile`): head for the start, and for an agent starting mid-file the 256 KiB before its `fileOffset` (never past it: the live reader folds those) for branch and cost. At offset 0 the live replay does it all. A new `jsonlFile` (`/clear`, resume) starts the fold over and the message replaces the old one. A cost undercounts when a process's rows sit before the tail window.
- **Folder**: a global-scan adoption takes `basename(cwd)` of the newest record with a `cwd` (`folderNameFromTranscript`), then the old hashed-dir segment. Hook adoption and the workspace-dir scan are unchanged.

### Tripwires (server/src/tripwires.ts)

Detection rules over each agent's tool calls, evaluated in `HookEventHandler.handleEvent` for every normalized `toolStart` of a tracked agent, before the display skips (Task/Agent, inline teammates). Alert-only: the hook script ignores the response, so there is nothing to deny with. User guide: `docs/tripwires.md`.

- **Provider-agnostic**: rules see `normEvent.toolName` + `normEvent.input`; no Claude field names outside `claude.ts`.
- **A rule hits when `tool` matches and `input` matches ANY string leaf** (depth 6, `ignoreKeys` skipped at any depth, no truncation). Exclusions are negative lookaheads inside `input`, never an "unless", so one benign token cannot mask a malicious one in the same call.
- **Privacy**: matched text and tool input never leave the server. The wire carries rule id, validated rule name, severity and count; the log line is `Tripwire <ruleId> agent <id>` only.
- **State** is `AgentState.tripwire` (not persisted): `count` is every hit since the last ack, the shown rule is the highest severity seen since then. `ackTripwire` clears only when the client's count covers the current one, otherwise it re-sends the state. VS Code and standalone both call the shared `ackTripwire` and broadcast the reply.
- `resendAgentActivity` sends `agentTripwire` or `agentTripwireClear` for every agent on reconnect.
- **Regex idioms are load-bearing** (see `tripwireDefaults.ts`): atomic first-occurrence prefix for "keyword, then X on the same line", bounded `{0,6}` option skipping. The backtracking budget tests guard them, on ~60 KB inputs and on 1 MiB string leaves (the hook body limit).
- **User patterns in `tripwires.json` are neither capped nor verified**: they must be linear, since a string leaf can be up to 1 MiB and the server runs on one event loop.

### Agent health (server/src/health.ts)

The office names agents that need a look: `stuck`, `stalled`, `looping`, `dead`, by precedence dead > stalled > looping > stuck. Shadow agents (sub-agent mirrors, ids from `SHADOW_ID_BASE`) are never tracked.

- **Calls and results come from the agent's own transcript only**, in hooks and heuristic mode alike, counted in `processTranscriptLine` above every hooks-mode gate. A PreToolUse next to its transcript record would count a call twice; hooks only move the clocks. A tool_result is named through the detector's own `toolUseId -> {name, inputHash}` memory (last `HEALTH_TOOL_MEMORY` calls), never through `activeToolNames`.
- **stuck**: `HEALTH_STUCK_RUNS` red runs (a shell result whose runner summary, `parseTestSummary`, has a failure) with no green run, successful edit (`is_error !== true`) or prompt between them. A shell result with no summary neither counts nor resets: an exit code is not evidence. A failed edit does not reset.
- **looping**: the same tool name and input hash `HEALTH_LOOP_REPEATS` times in a row. The hash is sha256 over the input with keys sorted at every depth and the top-level `description` dropped; only the hash is kept. A prompt or a turn end starts over. Polling loops count too.
- **stalled**: a turn is open (`turnOpenAt`, set by a prompt or the first tool_use/PreToolUse, cleared at every turn end, SessionEnd and the tick that first finds the process dead) and nothing moved for `HEALTH_STALLED_MS` (`TURN_LONG_TOOL_STALE_MS` while ANY open call is a long-running tool). The clock is the newest of every transcript line, every hook (a sub-agent's included) and, at the tick, the lead + sub-agent transcript mtimes. Never while the agent waits on the user: `isWaiting`, an open user-input tool, or a pending permission prompt (cleared only by a later hook, a prompt or a tool_result that leaves no call open; never by the tool_use line that can be read after the prompt, nor by a parallel call's result). `count` is whole minutes, re-sent as it grows.
- **dead**: the tick asks `provider.liveness` (Claude: `sessionFiles.ts`); `dead` sets it and ends the turn the process was in (open calls and repeats too), a later `alive` (a resume under a new pid) clears it, so a resumed session idles at its prompt. After `HEALTH_DEAD_REMOVE_MS` an external agent is removed the way SessionEnd removes one, but not dismissed and dropped from the known files, so a resume writing to the transcript is adopted again. Terminal agents stay gray until closed: the server never disposes a terminal on a timer. A teammate in its lead's session (inline or background) is the lead's process and follows it, never removed on its own: that would unregister the lead's session, and the scan would seat a background teammate again.
- **Wire**: every mutation and every tick recomputes the state and broadcasts only a change (`agentHealth {state, reason, count}` or `agentHealthClear`). `reason` is an enum: no session text can reach the wire through it. A new session on the character (SessionEnd, /clear, reassign) resets everything but what clients were last shown, so a visible mark is cleared. History replayed at adoption holds compares until it is read, then compares once. `resendAgentActivity` sends the mark or a clear for every agent, after the tripwire message and before the roster.
- **Webview**: smoke over stuck and looping, a pause mark over stalled, in the beacon's slot above it; a dead agent's sprite is drawn gray (`ctx.filter`, faded where a context has none) with no mark. The full box shows the reason as a plain line; its × is the acknowledgement for a dead agent. `officeState.health` ignores ids with no character.

### XP (server/src/xp.ts, server/src/xpAward.ts)

XP pays for real work only; activity (turns, tool calls, sub-agents) pays nothing. User guide: README, "A crew that remembers".

- **Who earns**: awards come only from the lead's own transcript tool results; hooks feed mood only; sidechain records, teammates (`leadAgentId`), sub-agents (shadow store, no roster) and hooks-only providers never award. The award is not behind `hookDelivered`: no hook carries the evidence.
- **Signals**: `toolVerdicts` reads the tool_use (Claude: Bash `git commit`/`cherry-pick`, `gh pr create`/`merge`, test runners; Edit/Write/MultiEdit/NotebookEdit as edits), `resultSignals` the record's single tool_result; an `is_error` result proves nothing. A merge prints nothing to read, so it pays on a successful result alone: a verdict must come from a command that runs (heredoc bodies, quoted spans and comments are text, a segment with `-h`/`--help` runs nothing), and gh's `was already merged` pays nothing. Commit +60 per `[branch sha]` line (amend 0, and no line pays from a command that also amends; at most `MAX_COMMITS_PER_TURN`), PR +120 per printed PR URL, merge +200 (`--auto` merges nothing), tests +40 when a runner's own summary is green, none is red (a TAP `not ok` included), and an edit came since the last paid green run (at most `MAX_TESTS_PER_TURN`). No summary, no award.
- **Dedupe**: hashed keys per agent for the process lifetime (`AgentState.signals`, capped at `SIGNAL_KEYS_MAX`); the turn caps reset on a user prompt only. Nothing is persisted. A read from offset 0 sets `AgentState.historyBefore` (`fileWatcher.ts` `readNewLines`), and a result stamped more than `TRANSCRIPT_FRESHNESS_WINDOW_MS` before that read pays nothing: a young file can open with hours of copied history. `pr-link` records are skipped silently: they are re-appended per PR, including PRs the session did not open.
- **Verdict lifetime**: `AgentState.toolVerdicts` lives from the tool_use to its tool_result and is cleared at transcript-ordered turn edges (prompt, interrupt, `turn_duration`), never on the Stop hook, which can land before the poll reads the last result.
- **Privacy**: command text and output never leave `claude.ts`; only verdicts and hashed keys do. roster.json holds counts only.
- **Mood**: `streak` counts awards since the last failed tool (happy at 1). PostToolUseFailure adds a consecutive failure (frustrated at 3), PostToolUse clears them; PreToolUse feeds nothing, or the count would reset before every failure.
- **Wire**: one `rosterEvent` per award carrying `signal`; `level` only on `levelUp` (the contract's minimum is 2). The webview pop reads "+60 commit", "+120 PR", "+200 merged" or "+40 tests green" (`xpPopLabel`, which also sizes the pop's box), at most once per `XP_POP_COOLDOWN_MS` (1.5 s) per agent.

### Official usage limits (statusline-tee.js, server/src/usage/)

Claude Code passes its status line command a JSON on stdin that carries the official `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at` in epoch seconds). The ledger only estimates those windows from tokens, so a wrapper reads them. Design record: `docs/adr/0002`.

- **The wrapper** is provider `claude-statusline` (`claudeStatusline.ts`), off by default and consent-gated like the hooks. Installed, `statusLine.command` is `node "<~/.pixelmates/hooks/statusline-tee.js>" '<original>'` (sh single-quote escaping, no argument when there was no status line). It spawns the original at once with `shell: true`, inherited env, cwd, stdout and stderr (ANSI and OSC 8 bytes never pass through it), forwards stdin chunk by chunk, and exits with the original's code (128 + signal; 127 if it cannot start). Up to 256 KiB of stdin is parsed; the body is built from scratch (`{fiveHour, sevenDay}`, each null or `{usedPercentage, resetsAt}`) and POSTed to every `readServerTargets` target, each request destroyed 150 ms after creation. It prints nothing; the only log is the opt-in debug file. POSIX only: the provider's install throws on win32.
- **Install / uninstall** (`claudeStatuslineInstaller.ts`, through the hook installer's guarded write): no statusLine → the wrapper alone; `{type: 'command', command}` → only the command is replaced, every other field kept; already ours → no-op; anything else → refused naming the keys found. Uninstall reads the original back out of the wrapper's argument; a statusLine that is not ours by identity (hook rule plus "nothing, or exactly one single-quoted word") is left as is and logged. Extension removal restores it too (`uninstall.ts`).
- **Route + store**: `parseUsageLimitsBody` refuses anything but the two windows (an extra key at either level, a non-number, out of range, both null) with 400. `UsageLimitsStore` keeps one sample per window and replaces it only with one not older (later `resetsAt`, or the same with equal or higher usage), since every session posts the same account-wide limits and an idle one re-posts its last snapshot; an accepted post advances `receivedAt` and broadcasts `usageLimits`. A new reset time anchors the token ledger (`anchorQuota`), so its window captions read `quota`.
- **Handshake**: the process that owns the HTTP server sends `usageLimits` on every connect, with both windows null and `receivedAt` 0 before the first reading. A VS Code window reusing another window's server sends none, so its panel shows nothing new rather than waiting forever.
- **Webview** (`limitsPace.ts`): the Usage panel shows one official row for the open tab above the token totals, whatever state they are in; fresh under 10 minutes, then dimmed with its age until that window's reset, then absent (never 0). Pace is computed at `receivedAt`: projection = used / elapsed fraction (skipped in the first 5 % of the window or with nothing used), a run-out time once it passes 100 %, and at most one nudge, the weekly window first. Not installed: a hint to turn it on. The HUD card adds `5h 37% · 7d 12%` while a window is live.

## Office UI

**Rendering**: Game state in imperative `OfficeState` class (not React state). Zoom = device px per WORLD px, restricted to `ZOOM_LEVELS` {1, 2, 3, 4, 6, ..., 20} (3 is the one odd level: an art px is 1.5 device px there, accepted so a monitor beside the rail fills a 1080 p column); art is `ART_DENSITY` (2) art px per world px, so an art px is zoom/2 device px and zoom 1 draws a 2x2 alpha-weighted downsample. The badge shows zoom/2; fit, +/- and the wheel walk the levels (`snapZoom`, `stepZoom`). No `ctx.scale(dpr)`. Default zoom = `Math.round(2 * devicePixelRatio)` snapped down to a level. World->device is `worldToDevice` (scale, then round once), shared by the canvas and the DOM overlays. Z-sort all entities by Y. Pan via middle-mouse drag (`panRef`). **Camera follow**: `cameraFollowId` (separate from `selectedAgentId`) smoothly centers camera on the followed agent; set on agent click, cleared on deselection, manual pan or Fit. A map that fits the view is never followed (the frame loop drops the follow: the clamp centres that map anyway, and a follow would switch the fit off). A map cut by at most `SHEET_FIT_EDGE_CUT` (5%) of its width a side still counts as fitting (`mapFitsView`). **Inspector sheet and the camera**: below 1600 px the sheet overlays the stage and AutoFit's view inset keeps the fit, every pan clamp and the follow in the uncovered width. Opening it re-fits for size (`sheetFit`): the whole map at the largest level that fits with that edge cut, but never under the zoom the office had nor under `SHEET_MIN_ZOOM` (1x); when that overflows, the camera follows the selected agent. Closing it clears the follow and re-fits as before.

**Render loop** (`engine/gameLoop.ts`): the canvas draws only as often as the office moves. After every update the busier of `OfficeState.activityLevel()` and the canvas's own level (edit mode, a fit still easing, a camera follow or greeter drift not landed) picks the mode: `active` runs on animation frames capped at `ACTIVE_FPS_CAP` (30) and lingers `ACTIVE_LINGER_MS` after the last active reading or wake; `ambient` (only slow loops: anyone in the office, an awake pet, lit fairy lights, a monitor left on) steps and draws on a 100 ms timer; `idle` steps on the same timer but draws once a second, for the light of the hour, plus the tick that left `ambient`. Timer ticks step in fixed `IDLE_STEP_SEC` (= `MAX_DELTA_TIME_SEC`) steps, so every dt timer keeps wall time and only drawing slows down. Hidden (the document, or the canvas off screen: a VS Code panel kept alive) nothing ticks. Anything that changes what is drawn outside a host message, a canvas input or a resize must call `requestRedraw()`, or it shows up to a second late; the message handler wakes on every type except the periodic ones in `NO_WAKE_MESSAGE_TYPES` (`tokenUsage`, re-sent every 30 s, and `usageLimits`, which only the DOM reads). DOM overlays redraw through `useFrame` after each drawn frame, never with a rAF loop of their own. Motion is time-based, never per frame: a walk carries its overshoot into the next tile, and the camera follow eases per second and lands within `CAMERA_FOLLOW_SNAP_THRESHOLD` of its legal goal (a bare lerp never settles and would pin the loop at 30 fps). e2e reads the loop through `window.__pixelAgentsTestHooks.frames` (`raf`, `update`, `render` counts and `mode`), as deltas.

**Cozy look**: brand CSS vars (`--brand-ink/-paper/-paper-2/-gold/-rust`, `--brand-shadow`, `--page-bg`) in `index.css`; `.brand-panel` / `Button variant="brand"` apply them to the toolbar, Settings, Usage, zoom controls and the HUD clock. Lighting is split because the canvas is transparent outside the map: a DOM `LightingTint` (soft-light, sized by `mapRectCss` through the same `overlayProjection` as the labels) plus canvas glows clipped to the map. At night the DOM tint is off and the canvas multiplies the map by `NIGHT_DARKEN_*` (ramped over `NIGHT_RAMP_MIN` either side of the phase by `nightDarkness`), then lays the lamp, monitor and fairy-band pools back on with `POOL_BLEND_MODE` (soft-light; the fairy bulbs and the glows stay `screen`). Pools are clipped to the map only; the fairy band is also cut to the wall rows under its strand; bubbles and DOM overlays stay outside it. `cozyLighting` toggles both. The Area color wash draws only while the Areas tool is active; Show Areas shows room signs only. Camera auto-fit (`AutoFit`) zooms only out by itself; the Fit button re-frames.

**UI styling**: Pixel art aesthetic — sharp corners (`borderRadius: 0`), solid backgrounds (`#1e1e2e`), `2px solid` borders, hard offset shadows (`2px 2px 0px #0a0a14`, no blur). CSS variables in `index.css` `:root` (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...). Pixel font: FS Pixel Sans (`webview-ui/src/fonts/`), loaded via `@font-face`, applied globally.

Custom ESLint rules (`eslint-rules/pixel-agents-rules.mjs`) enforce: `no-inline-colors` (hex/rgb/rgba/hsl/hsla literals only in `constants.ts`), `pixel-shadow` (must use `var(--pixel-shadow)`, `var(--brand-shadow)` or `2px 2px 0px`), `pixel-font` (must reference FS Pixel Sans). All `error`-level — they block PRs.

**Characters**: FSM states — active (pathfind to seat, typing/reading animation by tool type), idle (wander randomly with BFS, return to seat after `wanderLimit` moves). 4-directional sprites, left = flipped right. Tool animations: typing (Write/Edit/Bash/Task) vs reading (Read/Grep/Glob/WebFetch). Sitting offset: characters shift down 6 px in TYPE state. Z-sort uses `ch.y + TILE_SIZE/2 + 0.5` so characters render in front of same-row furniture but behind lower-row furniture. **Chair z-sorting**: non-back chairs use `zY = (row+1)*TILE_SIZE` (capped to first row); back-facing chairs use `zY = (row+1)*TILE_SIZE + 1` so the chair back renders in front of the character. Chair tiles are blocked for all characters except their own assigned seat (per-character pathfinding via `withOwnSeatUnblocked`).

**Seating by geometry (iteration 3a)**: no per-seat z flags. A face-on chair on a desk's background row sorts chair < agent < desk, and `layoutToSeats` gives the seat a `sink` read off the desk art so the desk hides `DESK_SEAT_COVER_PX` of the sprite; a back-view chair sorts in front of the agent; a couch (chair with more than one seat) is cut into a back slice (behind) and a front slice (in front, hiding `SOFA_FRONT_COVER_PX`) per footprint row. `seatedDrawOffsetPx` (seatDraw.ts) is the one draw offset for sprite, hit test, plate and bubble. **Idle life** (`engine/idleLife.ts`): `idlePose` maps status + time idle to typing / waitBubble / reading / napping / coffee, evaluated only on a status change (non-active ones after `POSE_SETTLE_SEC`) and every `POSE_TICK_SEC`; idle agents with a seat stay at it, and coffee drinkers (1 in 3 by id) walk to the cell beside a sofa cushion, then take one step onto it (max 2 on the sofas). **Camera**: the fit frames the rooms with a working agent (plus the lounge when anyone is in it, min two rooms) with `FIT_PADDING_CSS_PX` (8 CSS px) free on each side, the same padding for the whole map; pans are clamped by `clampOffset` (small map centred, big map void-free) and zoom keeps the anchor point still; plates scale by `zoom / max(fitZoomWholeMap, 2)`.

**Diverse palette assignment**: `pickDiversePalette()` counts palettes of current non-sub-agent characters; picks randomly from least-used palette(s). First 12 agents each get a unique palette (the 12 bundled sheets, skin from a fixed 5-tone ramp); beyond 12, palettes repeat with a random hue shift (45–315°) via `getHueLockedSprite()` that never touches `HUE_LOCKED` pixels (`core/src/assets/skinTones.ts`, shared with the art generator). Character stores `palette` (0-11) + `hueShift` (degrees). Sprite cache keyed by `"palette:hueShift"`.

**Spawn/despawn effect**: Matrix-style digital rain animation (0.3 s). 16 vertical columns sweep top-to-bottom with staggered timing. Spawn: green rain reveals character pixels. Despawn: character pixels consumed by green rain trails. `matrixEffect` field on Character (`'spawn'`/`'despawn'`/`null`). Normal FSM is paused during effect. Restored agents (`existingAgents`) use `skipSpawnEffect: true` to appear instantly; so does everything a reconnect's resync adds, and what it removes goes at once.

**Sub-agents**: Negative IDs (from -1 down). Created on `agentToolStart` with "Subtask:" prefix, or lazily by `subagentToolStart` when missing (watched background spawns, workflow agents, post-reload recreation), or by `subagentPresent` (workflow agents). Same palette + hueShift as parent. Click focuses parent terminal. Not persisted. Placement (`helperPlacement`): the nearest free desk seat in the parent's room, else the nearest free desk seat in the lobby (tiles outside every Area), else standing at least 2 tiles from the parent; never a couch, and no seat at all while the parent is not placed yet. Idle (stop typing) when every tracked sub-tool row is done; overlay shows the latest non-done sub-tool status, falling back to the Subtask label.

**Workflow crew helpers** (parentToolId `wf:...`, `subagentMessages.ts`): only `subagentToolStart` and `subagentPresent` create a helper (a presence draws it working with no tool row, so it never idles before its clear) (done, permission and clear for an unknown key are no-ops, so a batched done after a clear never revives one), and a `wf:` helper is always background whatever the lead's tool list says. The plate reads `<label> · <state>` (label cut at 24 code points, inside a bidi isolate so it never reorders the words after it; a Task/Agent sub-agent shows its task description), the full box the full label with the group on a second line. The plate's helper fields (a lead's count of helpers without a character, a helper's label) come from `helperPlateInput` (toolUtils.ts) over the overlay's helper list. A top-level agent never takes a crew helper's seat (Task/Agent helpers still yield theirs). At most `WORKFLOW_MAX_VISIBLE_HELPERS` (12) crew helpers per lead are drawn; the rest exist without a character, count in the lead's "+N helpers", and the oldest is drawn, with its last tool and active state, as soon as a drawn one leaves.

**Monitor plates** (`ToolOverlay.tsx`, pure parts in `plateState.ts`, `medal.ts`, `nameplate.ts`, `crewBanner.ts`, `crewLines.ts`, `deskHighlight.ts`, `monitorTags.ts`, `labelLayout.ts`): beside the rail (`monitorLayout(...).fullPlates`, read from the window size) every character carries one tag (`isMonitorTag`): one line, its type set by the map's CSS zoom (`monitorType`: from 3 CSS px per world px, 1920 beside the rail, name 24 and state 20 CSS px, which read 14 and 12 since FS Pixel Sans draws caps 7/16 em, about 0.6 of a common font; below, 16 and 14), at most 184 px (124 small), ellipsis. Line 1: an alert tab (`! 12m` permission, `? 4m` question, `× 9m` stuck: health stuck/looping/stalled or an unacked tripwire; minutes from the server `since`), the medal (pixel grid: context ring clockwise, coral from 85%, tier glyph; track only without context), the name, `↻` for a loop, then the state by precedence needs you > done (a helper whose spawn row is done) > `› command` > tool verb > `asleep until HH:MM` > `idle 1h08m` (quiet tag). A monitor tag never cuts its state: it says it whole or leaves it out (`tagStateText`, at most 10 characters: `wake 15:45`, `idle 12m`, `idle 1h08`, a verb as is, a command or its first word, `done`), and `plateFit` returns `none` rather than `cut` there. A quiet tag is opaque ink (`NAMEPLATE_BG`) with its words in `--mon-cream-3`: no alpha on a tag, the office never shows through it. The plate's alert and the desk highlight read the same `OfficeState.attentionFacts` (a question is the waiting status with `awaitingInput`, not the bubble, which fades). A helper's tag shows only while its lead is selected or it is hovered, as one word (its state; a command's word is `pv`) on paper with no ink box. A lit agent keeps its alert tab on its tag (tab, medal, name; no desk badge exists), and the tag is pinned to its desk's frame, placed first: on the outline's top edge, or under its bottom edge for an agent seated facing up, its left edge on the outline's outer left (its right edge on the outer right when that crosses the room's right bound; a wider label overhangs). On a collision it slides along the edge (dy 0, up to its width), then tries the other edge, then falls back to the slots below on a leader. Such a tag draws no status glyph, and beside the rail no bubble is drawn over a lit agent's head (`OfficeState.hideLitBubbles`, `bubbleShown`, `alertOnTag`: the renderer, `headSlotTaken` and `statusGlyph` share them; a VS Code panel keeps its bubble). `placeTags` hangs every other tag from its agent's open side (`openSideSlots`, `OfficeState.seatFacingOf`): under its desk unit when seated facing up (the desk is over its head), above its head otherwise (face-on, on a couch, standing). Only when nothing is free there does it try the other side, always on a leader. The search is first within 8 px of a slot, then 24, then 64, in 8 px steps (vertical before sideways): never on a sprite body, a plaque, a banner, another agent's lit desk or another tag (windows are not obstacles: a tag over a window is cosmetic), and never outside the room of the tile the agent stands on now (`tagRoom`: floor and top wall; the whole map on a tile with no area), a tag's width capped at that room's. A tag moved more than 8 px, left more than 24 px from what it hangs from, or on the other side, gets a 2 px ink leader (`tag-leader`), which must reach its anchor and cross no obstacle. Order: the crew banners, then alerts, agents and helpers. Without the rail (a VS Code panel) the older plates apply: line 2 (branch · transcript age · `N artifacts`) from zoom level 4, `fitPlateWidths`, the push-and-clamp pass, faint plates. Session text carries `pv`. Room plaques (DOM, `room-plaque`) beside the rail: one per Area on its top wall, ink box, the title in gold caps and the mapped folder (`pv`) under it at the tag type's plaque sizes, each line trimmed to the caps; the canvas signs then stay off. One crew banner (DOM, `crew-banner`) per running workflow run with drawn helpers, placed before the tags: on its helpers' room's top wall band (its lead's when the helpers stand in the lobby) in two rows down to 0.75 scale, else in one row (name, lead, the phase running now) shrinking to 0.5; the nearest free spot over the helpers only when no band takes it; none while the inspector shows its lead (or one of its helpers). The desk of a session that needs you is lit on the canvas (pure ops in `deskHighlight.ts`): a 12% wash of its color on the carpet under the furniture and people, and over the night and the glows a 4 px outline in the rail tile's color (gold waiting, `--mon-rust` stuck) with a 1 px ink line inside it and a 4 px hard halo (CSS px) on every other half second of `officeNow()`, around the desk, its seat and the agent at it; two lit desks closer than 8 CSS px keep that air (`separateFrames`: the facing sides move to the midline, draw no halo, and each wash is clipped to its outline); a lit desk keeps the loop `ambient`, never `active`. Crew lines are floor cables (canvas, under furniture and people) along the aisles from each lead to its drawn helpers, solid to crew helpers, dashed to sub-agents. e2e reads the canvas through `getCrewLines()`, `getDeskHighlights()` and `getTagLayout()` (tags with their anchor and leader, faces, the rooms a tag may fill, banners, plaques; `getDeskHighlights()` also gives the desk's page rect). The selected agent's full box stays closed while the inspector sheet is open (its tag turns paper).

**Speech bubbles**: Permission ("..." amber dots) stays until clicked/cleared. Waiting (green checkmark) auto-fades 2 s. Sprites in `spriteData.ts`. Above the head, bottom up: the bubble, the tripwire beacon, the health mark; the idle z only when none of them (nor a dead state) holds the slot.

**Sound notifications**: Ascending two-note chime (E5 → E6) via Web Audio API plays when waiting bubble appears (`agentStatus: 'waiting'`), except inside a reconnect's resync window, whose resend restates every status. `notificationSound.ts` manages AudioContext lifecycle; `unlockAudio()` on canvas mousedown resumes the context (webviews start suspended). Toggled via Settings modal. Persisted per-namespace in `~/.pixelmates/config.json`.

**Seats**: Derived from chair furniture. `layoutToSeats()` creates a seat at every footprint tile of every chair. Multi-tile chairs produce multiple seats keyed `uid` / `uid:1` / `uid:2`. Facing direction priority: 1) chair `orientation` from catalog (front→DOWN, back→UP, left→LEFT, right→RIGHT), 2) adjacent desk direction, 3) forward (DOWN). Click character → select (white outline) → click available seat → reassign.

## Layout Editor

Toggle via "Layout" button. Tools: SELECT (default), Floor paint, Wall paint, Erase (set tiles to VOID), Furniture place, Furniture pick (eyedropper for furniture type), Eyedropper (floor).

**Floor**: 7 patterns from `floors.png` (grayscale 16×16), colorizable via HSBC sliders (Photoshop Colorize). Color baked per-tile on paint. Eyedropper picks pattern+color.

**Walls**: Separate Wall paint tool. Click/drag to add walls; click/drag existing walls to remove (toggle direction set by first tile of drag, tracked by `wallDragAdding`). HSBC color sliders (Colorize mode) apply to all wall tiles at once. Eyedropper on a wall tile picks its color and switches to Wall tool. Furniture cannot be placed on wall tiles, but background rows may overlap walls.

**Furniture**: Ghost preview (green/red validity). R key rotates, T key toggles on/off state. Drag-to-move in SELECT. Delete button (red X) + rotate button (blue arrow) on selected items. Any selected furniture shows HSBC color sliders (Color toggle + Clear button); color stored per-item in `PlacedFurniture.color?`. Single undo entry per color-editing session (tracked by `colorEditUidRef`). Pick tool copies type+color from placed item. Surface items preferred when clicking stacked furniture.

**Undo/Redo**: 50-level, Ctrl+Z/Y. EditActionBar (top-center when dirty): Undo, Redo, Save, Reset.

**Multi-stage Esc**: exit furniture pick → deselect catalog → close tool tab → deselect furniture → close editor.

**Erase tool**: Sets tiles to `TileType.VOID` (transparent, non-walkable, no furniture). Right-click in floor/wall/erase tools also erases to VOID (drag-erasing supported). Context menu suppressed in edit mode.

**Grid expansion**: In floor/wall/erase tools, a ghost border (dashed outline) appears 1 tile outside the grid. Clicking a ghost tile calls `expandLayout()` to grow the grid by 1 tile in that direction. New tiles are VOID. Furniture positions and character positions shift when expanding left/up. Max: `MAX_COLS`×`MAX_ROWS` (64×64). Default: `DEFAULT_COLS`×`DEFAULT_ROWS` (20×11). Characters outside bounds after resize relocated to random walkable tiles.

**Layout model**: `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors?: ColorValue[] }`. Grid dimensions are dynamic. Persisted via debounced saveLayout message → `writeLayoutToFile()` → `~/.pixelmates/layout.json`.

## Asset System

**Loading**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. Loader checks bundled path first, falls back to workspace root. PNG → pngjs → SpriteData (2D hex array, alpha≥2 = visible, `#RRGGBBAA` for semi-transparent). `loadDefaultLayout()` reads `assets/default-layout.json` as fallback for new workspaces.

**Catalog**: `furniture-catalog.json` with `id, name, label, category, footprint, isDesk, canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?`. String-based type system. Categories: desks, chairs, storage, electronics, decor, wall, misc. Wall-placeable items use the `wall` category and appear in a dedicated "Wall" tab. Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]` (e.g., `MONITOR_FRONT_OFF`).

**Per-furniture manifests**: Each furniture item lives in its own folder under `assets/furniture/` with a `manifest.json` that declares its sprites, rotation groups, state groups (on/off), and animation frames. Floor tiles are individual PNGs in `assets/floors/`; wall tile sets in `assets/walls/`.

**Rotation groups**: `buildDynamicCatalog()` builds `rotationGroups` Map from assets sharing a `groupId`. Supports 2+ orientations (e.g., front/back only). Editor palette shows 1 item per group (front orientation preferred). `getRotatedType()` cycles through available orientations.

**State groups**: Items with `state: "on"` / `"off"` sharing the same `groupId` + `orientation` form toggle pairs. `stateGroups` Map enables `getToggledType()` lookup. Editor palette hides on-state variants. State groups are mirrored across orientations.

**Auto-state**: `officeState.rebuildFurnitureInstances()` swaps electronics to ON sprites when an active agent faces a desk with that item nearby (3 tiles deep in facing direction, 1 tile to each side). Operates at render time without modifying the saved layout.

**Background tiles**: `backgroundTiles?: number` — top N footprint rows allow other furniture to be placed on them AND characters to walk through. Z-sort places bg-row items behind the host furniture.

**Surface placement**: `canPlaceOnSurfaces?: boolean` — items like laptops, monitors, mugs can overlap with all tiles of `isDesk` furniture. `canPlaceFurniture()` builds a desk-tile set and excludes it from collision checks. Z-sort: surface items get `zY = max(spriteBottom, deskZY + 0.5)`.

**Wall placement**: `canPlaceOnWalls?: boolean` — items like paintings, windows, clocks can only be placed on wall tiles. `canPlaceFurniture()` requires the bottom row of the footprint to be on wall tiles; upper rows may extend above the map. `getWallPlacementRow()` offsets placement so the bottom row aligns with the hovered tile.

**Colorize module**: `colorize.ts` with two modes selected by `ColorValue.colorize?` flag. **Colorize mode** (Photoshop-style): grayscale → luminance → contrast → brightness → fixed HSL; always used for floor tiles. **Adjust mode** (default for furniture and character hue shifts): shifts original pixel HSL. Both remap each distinct color once. Results are memoized per (source sprite, color key), so the same request returns the same object.

**Art density**: every decoded SpriteData is at `ART_DENSITY` (2). The pure decoders in `core/src/assets/artDensity.ts` (used by pngjs, the Vite plugin and browserMock) detect 1x vs 2x by the ratio to the legacy size and upscale 1x art nearest-neighbour, so legacy and external 1x assets render exactly as before. Furniture manifests keep `width`/`height` in WORLD px; the PNG must be 1x or 2x of them or the item fails to load, naming its id (an optional manifest `density` is validated, never trusted). Flair JSONs declare `density` (absent = 1x); their offsets and `anchors.json` are world px. Sizes in world px come from `spriteWorldWidth/Height` (art / ART_DENSITY).

**Floor tiles**: `floors/floor_N.png` (16×16, or 32×32 HD). Colorized per (sprite, h, s, b, c).

**Wall tiles**: `walls/wall_N.png` (64×128, or 128×256 HD: 4×4 grid of 16×32 world px pieces). 4-bit auto-tile bitmask (N=1, E=2, S=4, W=8). Sprites extend 16 px above tile (3D face). `wallTiles.ts` computes bitmask at render time. Colorizable via HSBC sliders. Wall sprites z-sorted with furniture/characters (`getWallInstances()` builds `FurnitureInstance[]`).

**Character sprites**: 12 pre-colored PNGs (`assets/characters/char_0.png`–`char_11.png`), one per palette. Each 112×128 (224×256 HD): 7 frames × 16 world px wide, 4 rows × 32 world px tall. Row 0 = down, Row 1 = up, Row 2 = right, Row 3 = front-view idle poses (sit-idle, head-down, page-turn A/B, head-down breathing in, sip), decoded as `down` frames 7–12; a sheet with fewer poses ends the row early and the runtime reuses head-down and sit. Napping alternates the two head-down frames every `NAP_BREATH_SEC`; the coffee pose sips. Each agent's book cover and mug body are a stable pick by agent id from `idle-props.json` (`book.covers`, `mug.bodies`); the mug steams (`steam`, 3 frames) and a napper shows the `zz.json` glyphs, at most two, rising and fading from a world-px spawn point. Frame order: walk1, walk2, walk3, type1, type2, read1, read2. Left = flipped right at runtime. When `hueShift !== 0`, `hueShiftSprites()` applies `adjustSprite()` to all frames before caching.

**Load order**: `characterSpritesLoaded` → `floorTilesLoaded` → `wallTilesLoaded` → `furnitureAssetsLoaded` → `layoutLoaded`.

## Testing

Three tiers, each with its own framework.

### Server unit/integration (Vitest)

`server/__tests__/` covers the shared runtime, persistence, providers, HTTP/WebSocket server, CLI, diagnostics, asset reloads, and the e2e scenario runner. Representative suites include:

| File                                                  | Coverage                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentStateStore.test.ts`                             | Mutations, EventEmitter events, snapshot                                                                                                                |
| `hookEventHandler.test.ts`                            | Routing, buffering, normalized dispatch, team gating                                                                                                    |
| `sessionRouter.test.ts`                               | session_id mapping, pending sessions, buffer flush                                                                                                      |
| `fileWatcherDismissal.test.ts`                        | DismissalTracker integration                                                                                                                            |
| `fileStateAdapter.test.ts`                            | Namespaced persistence, allowlist, settings round-trip                                                                                                  |
| `migrateVsCodeState.test.ts`                          | Verify-before-clear, partial migration                                                                                                                  |
| `teamUtils.test.ts`                                   | Inline-teammate helpers                                                                                                                                 |
| `claudeTeamProvider.test.ts`                          | Discovery, membership, metadata extraction                                                                                                              |
| `claude.test.ts`                                      | `normalizeHookEvent` per Claude event, file fallback                                                                                                    |
| `claudeHookInstaller.test.ts`                         | Atomic install/uninstall, unparseable-file + non-array abort, throwing writes, mode preservation, backup, hook identity, event-scope migration          |
| `consentFlow.test.ts`                                 | In-app consent over the wire: who is asked, what each answer writes, Back-and-revise semantics, answer serialization                                    |
| `claude-hook.test.ts`                                 | Spawned hook script integration (needs `dist/hooks/claude-hook.js`)                                                                                     |
| `statusline-tee.test.ts`                              | Spawned status line wrapper (needs `dist/hooks/statusline-tee.js`): only the two windows leave, byte-exact output and exit code, POST budget, stdin cap |
| `claudeStatuslineInstaller.test.ts`                   | statusLine chain and exact restore, hand edits left alone, wrapper identity, no backup of our own output                                                |
| `usageLimitsBody.test.ts`, `usageLimitsStore.test.ts` | Statusline route body contract; per-window merge and ledger anchoring                                                                                   |
| `uninstall.test.ts`                                   | Spawned `dist/uninstall.js`: every provider leaves settings.json, the status line comes back                                                            |
| `server.test.ts`                                      | HTTP lifecycle, auth, `/ws`, broadcast                                                                                                                  |
| `httpServerWs.test.ts`                                | `/ws` gate: standalone same-origin, embedded Bearer                                                                                                     |
| `mockClaudeRunner.test.ts`                            | E2E scenario runner sanity                                                                                                                              |
| `memoryTools.test.ts`                                 | Memory tools over synthetic transcripts: scope, asked/ended, commits/PRs, files, tests, budgets, cap ladder, last_update, `under`                       |
| `memoryServer.test.ts`                                | The committed memory bundle over stdio: ids, notifications, error codes, `_meta`, stderr carries no transcript text                                     |
| `memoryRedact.test.ts`                                | Redaction table: each rule's positive and negative case                                                                                                 |

Run: `npm run test:server` (or `npm test` for all).

### Webview unit (Vitest, Node runner)

`webview-ui/test/` covers office state, layout editing and migration, assets, changelog behavior, and Vite/browser wiring.

Run: `npm run test:webview`.

### End-to-end (Playwright)

`e2e/` contains Playwright tests against a real VS Code Electron instance and a standalone Fastify server. CI runs only the standalone project (`npm run e2e:standalone`) on Linux at `--workers=1`; the VS Code suite is local. The generated [e2e inventory](e2e/README.md) is the source of truth for current specs, scenarios, and `@area:` coverage.

**Mock claude**: Tests never invoke real `claude`. A bash script (`e2e/fixtures/mock-claude`) is copied into an isolated `bin/` and prepended to `PATH`. The scenario runner (`mock-claude-runner.cjs`) honors `claudeScenario(...).at(ms).appendJsonl(record).emitHook(event).holdOpenFor(ms).build()` to drive timed JSONL writes and hook events.

**Authoring rules (normative)**: before writing a new spec, read `e2e/README.md` → "Mocking model & rules". It is the single source of truth for the process-boundary principle, the append-only transcript rule, the assert-on-visible-outcomes discipline, and the one standalone-server exception. New tests must follow that model.

**Isolation**: each test gets its own `tmpHome`, workspace directory, VS Code `--user-data-dir`, and mock-log file. No state leaks between tests.

**Auto-fixtures**: `_allureLabels` (auto: true) reads `@area:<tag>` from `testInfo.tags` and applies the corresponding Allure epic.

**Single source of truth for test inventory**: `e2e/README.md` contains an auto-generated section spliced between `<!-- BEGIN:E2E-INVENTORY -->` and `<!-- END:E2E-INVENTORY -->` markers. CI regenerates via `npm run e2e:inventory` and fails on `git diff --exit-code e2e/README.md`.

Run:

```bash
npm run e2e                                    # all tests
npm run e2e -- --workers=1                     # single worker (matches CI sharding)
npm run e2e -- --grep "lifecycle"              # filter by name
npm run e2e:debug                              # step-through
npm run e2e -- --attach-videos-on-success      # keep videos for passes too
npm run e2e:inventory                          # regen e2e/README.md inventory
npm run e2e:perf                               # render cost per dev scene (own config, not in the suite)
npm run test:report                            # build combined Allure report
npm run test:report:open                       # serve Allure locally (file:// can't fetch)
```

**Reproducing CI failures locally**: CI uses `--workers=1` because the runners can't handle more. Reproduce locally with `npm run e2e -- --workers=1 --grep "<test>"`. For full Linux fidelity, `act -j linux-e2e --matrix shard:1 -P ubuntu-latest=catthehacker/ubuntu:full-22.04 --container-architecture linux/amd64` or run inside `mcr.microsoft.com/playwright:v1.58.2-noble` Docker with `--cpus=2 --memory=4g` to simulate runner throttling.

## Build & Dev

**npm workspaces monorepo** (`server`, `webview-ui`). A single `npm install` at the root installs deps for all workspaces; `cd webview-ui && npm install` is redundant.

```bash
npm install                # installs root + workspaces in one shot
npm run compile            # asyncapi:generate, check-types, lint, esbuild, vite
npm run build              # alias for compile
npm run package            # production build (esbuild --production)
npm test                   # webview + server vitest
npm run e2e                # Playwright
```

`esbuild.js` runs four bundles:

1. **Extension** (`dist/extension.js`) from `adapters/vscode/extension.ts`. External: `vscode`.
2. **CLI** (`dist/cli.js`) from `server/src/cli.ts`. Externals pulled at install time (`fastify`, `@fastify/*`).
3. **Claude scripts** (`dist/hooks/claude-hook.js`, `dist/hooks/statusline-tee.js`) from `server/src/providers/hook/claude/hooks/`. CJS, shebang. Both sources sit in that one directory on purpose: entry points in different directories make esbuild nest the output under their common base. Watch builds skip them.
4. **Memory MCP** (`plugin/server/memory-mcp.cjs` + `dist/memory-mcp.cjs`) from `server/src/memory/mcpMain.ts`. Fixed options in every mode (node18 CJS, no minify, no sourcemap), so CI's `--production` build and `npm run plugin:build` (this bundle only) write the same bytes.

`define: { 'process.env.PIXELMATES_VERSION': JSON.stringify(version) }` stamps the package version into all bundles.

**Watch mode**:

```bash
npm run watch                       # parallel esbuild watch + tsc --noEmit watch
cd webview-ui && npm run dev        # Vite dev server (separate terminal)
```

The webview Vite dev server is **not** included in `npm run watch` — it has to be run separately.

**F5 in VS Code** launches the Extension Development Host with the local extension loaded.

### CI

`.github/workflows/ci.yml`: the `ci` job (install, `asyncapi:validate`, `asyncapi:generate` + drift check, `e2e:inventory` + drift check, `plugin:build` + drift check of `plugin/`, `check-types`, lint, webview and server tests, format check, build, package contract + npm artifact, audit and knip as advisory), `npm-package-node20`, `e2e` (the standalone Playwright project on ubuntu: `npm run e2e:standalone`, system deps from `playwright install --with-deps chromium`) and `required-checks`. The VS Code specs under `e2e/tests/claude` are a local suite and never run in CI. `release.yml` publishes to npm from a published GitHub release (trusted publishing, `--provenance`).

The drift checks are the central guarantees: `core/asyncapi.yaml` and `core/src/messages.ts` stay in lockstep; `e2e/README.md` stays in sync with the spec list; the committed `plugin/server/memory-mcp.cjs` and the plugin manifest version match `server/src/memory` and `package.json`.

## TypeScript Constraints

- **No `enum`** (`erasableSyntaxOnly` in webview) — use `as const` objects (`TileType`, `CharacterState`, `Direction`, `EditTool`).
- **`import type`** required for type-only imports (`verbatimModuleSyntax` in webview; convention in extension).
- **`noUnusedLocals` / `noUnusedParameters`** — strict everywhere.
- **`.js` extensions** on all relative imports in extension + server (Node16 module resolution).
- **Module Node16, target ES2022** in the extension/server. **`erasableSyntaxOnly`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`** in the webview.

## Constants Policy

All magic numbers and strings are centralized — never inline:

| Where                              | What lives there                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/constants.ts`          | All timing/scanning constants (`PERMISSION_TIMER_DELAY_MS`, `TEXT_IDLE_DELAY_MS`, scanner intervals) shared by extension and standalone |
| `adapters/vscode/constants.ts`     | VS Code-only IDs, command names, workspace state keys                                                                                   |
| `core/src/constants.ts`            | Protocol-level constants (e.g., transport state names)                                                                                  |
| `webview-ui/src/constants.ts`      | Webview magic numbers (grid, animation, rendering, camera, zoom, editor, game logic) + canvas overlay rgba strings                      |
| `webview-ui/src/index.css` `:root` | CSS custom properties (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...) for React inline styles and CSS                           |
| `webview-ui/src/office/types.ts`   | Re-exports grid constants from `constants.ts` for convenience                                                                           |

## Error Handling

- **Try-catch with graceful degradation** — errors logged but never crash the extension.
- **Malformed JSONL lines** silently ignored (catch block in `processTranscriptLine`).
- **Missing assets** logged with warning, operation continues with null/fallback.
- No centralized error reporting or telemetry.

## Logging

Use `console.log`/`error`/`warn` with prefixed context:

- Extension: `[pixelmates]`, `[Extension]`
- Asset loading: `[AssetLoader]`
- Webview: `[Webview]`

## Condensed Lessons

- `fs.watch` unreliable on Windows — always pair with polling backup.
- Partial line buffering essential for append-only file reads (carry unterminated lines). Leave an incomplete UTF-8 tail unread, behind the offset: decoding each chunk alone turns a split character into U+FFFD.
- Delay `agentToolDone` 300 ms to prevent React batching from hiding brief active states.
- **Idle detection** has two signals: (1) `system` + `subtype: "turn_duration"` — reliable for tool-using turns (~98%), emitted once per completed turn. (2) Text-idle timer (`TEXT_IDLE_DELAY_MS = 5 s`) — for text-only turns. Only starts when `hadToolsInTurn` is false; suppressed once `hadToolsInTurn` becomes true. Reset on new user prompt or `turn_duration`. Cancelled by ANY new JSONL data.
- User prompt `content` can be string (text) or array (tool_results) — handle both.
- `/clear` creates a NEW JSONL file (old file just stops).
- `--output-format stream-json` needs non-TTY stdin — can't use with VS Code terminals.
- Hook-based IPC failed in early prototypes (hooks captured at startup, env vars don't propagate). HTTP `/api/hooks/:providerId` with `~/.pixelmates/server.json` discovery works.
- PNG→SpriteData: pngjs for RGBA buffer, alpha threshold 2 (`PNG_ALPHA_THRESHOLD`), supports `#RRGGBBAA` semi-transparent pixels.
- OfficeCanvas selection changes are imperative (`editorState.selectedFurnitureUid`); must call `onEditorSelectionChange()` to trigger React re-render for toolbar.
- **External-session adoption**: scanner runs every 3 s. In hooks-OFF mode external scenarios, the test setup can race the first scanner tick. Mock-claude scenarios should give a few seconds of margin before assertions.
- **Heuristic sub-agent permission bubble timing**: the bubble lands 7 s after the SUB-TOOL is registered, not 7 s after the parent Task tool appears. Tests waiting on it from the "Subtask:" overlay need at least `1 s (Task→Bash gap) + 7 s timer + ~300 ms IPC/render = 9–10 s` budget.
- **runInBackground sub-character gate**: in webview `agentToolStart` (`applyToolStartHelper`), `runInBackground=true` Agent tools are gated out of sub-character creation when the parent has a `teamName` (teammate path handles it). With no `teamName`, the gate must be bypassed so the basic Subtask sub-character still renders. `addSubagent` dedups via `subagentIdMap`, so the bypass is safe even if a teammate is detected later. `subagentToolStart` creates the sub lazily when it's missing — covering teamed leads' unnamed background spawns and post-reload recreation.
- **Allure HTML report**: viewing via `file://` fails (browsers block `fetch()` from local files). Use `npx allure open allure-report/allure` or `npm run test:report:open`.
- **Context usage is a snapshot against a provider-declared window**, and both halves are easy to get wrong: cumulative sums measure spend rather than occupancy, `input_tokens` without the cache counters measures almost nothing, and a 200k window assumed for a 1M model reads five times too full (the number to check it against is Claude Code's own statusline `context_window.used_percentage`).

## Manual Hook Testing

`server/manual-hook-events.http` (REST-Client format) drives the local hook server while the extension is running. Copy `port` and `token` from `~/.pixelmates/server.json`, set `cwd` to a workspace folder opened in the Extension Development Host. Covers `SessionStart` → `PreToolUse` → `PermissionRequest`/`Notification`/`Stop` → `SessionEnd`.

If `cwd` is outside the current workspace, enable **Watch All Sessions** first.

## Asset Pipeline (legacy tileset import)

7-stage pipeline in `scripts/` for importing third-party tilesets (the bundled assets don't need this):

1. `0-import-tileset.ts` — Interactive CLI wrapper
2. `1-detect-assets.ts` — Flood-fill asset detection
3. `2-asset-editor.html` — Browser UI for position/bounds editing
4. `3-vision-inspect.ts` — Claude vision auto-metadata
5. `4-review-metadata.html` — Browser UI for metadata review
6. `5-export-assets.ts` — Export PNGs + `furniture-catalog.json`
7. `asset-manager.html` — Unified editor (stages 2+4 combined), Save/Save As via File System Access API

Supporting: `wall-tile-editor.html` (wall sprite editing), `jsonl-viewer.html` (transcript inspector).

## Key Decisions

- **The memory MCP reads on the fly, scoped by the server's own environment.** One stdio process per Claude Code session: no listener, no token. The project tools read only `~/.claude/projects/<normalizeProjectPath(CLAUDE_PROJECT_DIR or cwd)>` (lstat'd: a symlinked folder is refused) and keep only the transcripts whose recorded cwd is the project path, since folder names are lossy (`/a/b-c` and `/a/b/c` share one) and a hard-linked transcript passes every file check; no tool takes a path or a session id, and `recent_work_all_projects` takes a required `under` (a default would cover both work and personal trees for a session started at a zone root, unseen in the prompt), filters a listing by folder name and by each transcript's recorded cwd, asking the user on every call (`_meta` `anthropic/requiresUserInteraction`). Each call reads in two tiers under one budget: head and tail of every candidate (read on from the start to the first typed prompt when the head holds none: a pasted screenshot pushes it past the cut; the scope cwd and the start time come from the head or that read, never from the tail, where a session that cd'd has moved), then a prefiltered full scan newest first. A session the budget cut keeps its tier 1 fields and returns commits, files, tests, human_turns and kind as null with `partial: true`, never `[]` or 0. Every output string goes first 4,096 chars (dropping the word that cut splits, or half a token escapes its rule), NFKC, ANSI strip, redaction table, whole-field fail-closed check, cut; search matches that redacted text, because matching raw text turns hit counts into a one-character-per-probe oracle for secrets. Only typed prompts, the last assistant text, titles and structured metadata leave a transcript; tool results, tool inputs and thinking never do. stderr gets one counts-only line per call, and a JSON.parse failure is counted, never logged (its message quotes the input). No budget check runs inside a regex, so text from a transcript only meets linear scans: injected prompt spans are cut by indexOf (an opener with no closer drops the rest of the prompt), and digit-run patterns carry a `(?<!\d)` anchor.
- **Layered codebase** (core → server → adapters; core → webview-ui). Standalone CLI never imports `adapters/vscode/` and vice versa.
- **AsyncAPI 3.0 contract**, generated TS bindings, CI drift check. Single source of truth for the wire protocol.
- **AgentRuntime** shared lifecycle core, composed by both surfaces.
- **AgentStateStore** as single source of truth with typed mutations and typed events. No transport calls outside the broadcast layer.
- **Transport abstraction**: `MessageTransport` interface, `PostMessageTransport` + `WebSocketTransport`. One branching point in the entire UI.
- **HookProvider** as the integration boundary, with optional file fallback. New CLIs are a single subdirectory under `server/src/providers/hook/<id>/`.
- **TeamProvider** as optional extension. Claude Agent Teams is the only implementation.
- **Per-adapter namespaced persistence** under `~/.pixelmates/`. VS Code and standalone never clobber each other.
- **Verify-before-clear migration** for legacy VS Code state.
- **Single `WebviewViewProvider`** (panel area, not editor area).
- **Inline esbuild problem matcher** (no extra extension needed).
- **`erasableSyntaxOnly`** in webview forbids `enum` — use `as const` objects.
- **Server always starts** regardless of hooks toggle. Only hook installation is gated by the setting.
- **Consent before any FIRST settings-file write**, per provider (`hooksConsent: {providerId: 'granted'|'declined'}`, absent = unanswered; the `hooksEnabled` preference beside it is per-provider and machine-global). **Exactly one population is asked: the one with nothing of ours installed** — hooks already on disk are granted silently at startup, since that install only ever removes events. The ask is one step of the Intro, the four-step first-run tour a greeter character speaks in-app on both surfaces (`IntroBubble.tsx`); the server sends `hooksConsentRequest` during the `webviewReady` handshake, one per provider, privileged connections only, carrying the provider's own `consentDisclosure()` so no client-side copy can drift. The ask-or-not predicate, the choice→action rule, and the execution live ONCE in `server/src/providers/hook/` (`consentGate.ts` decides, `consentExecutor.ts` performs); surfaces supply only their effects. **A choice is an absolute state command, not an event** — Back re-opens the ask, so a revision undoes whatever the earlier answer left: hooks on disk, a grant a failed install recorded, or a decline's own persisted hooks-off. That is why the consent record is a tri-state and each answer commits in ONE config write; the full rule and its rejected alternatives are `docs/adr/0001`. An abort (close x, Escape) sends nothing and the whole Intro returns on the next page load (in-session reconnects are deduped by the webview); the closing step reports the install OUTCOME, not the click. **An off-by-default provider's Settings toggle-on over an unanswered ask asks first** (`toggleNeedsConsent`, both dispatches; the hooks toggle still installs directly, its click being the grant): the preference is recorded on and the provider's `hooksConsentRequest` goes out instead of an install; Install then installs through the executor, and a Not Now takes back a preference the toggle raised above an off-by-default provider's default (`preferenceRaised` → `revertDecline`; a revert after a landed install clears it too). An answered ask, granted or declined, keeps the direct install. A provider can be off by default (`HookProvider.defaultEnabled: false`, the status line wrapper): the handshake never asks about it, only that toggle does. The App closes Settings when the ask it triggered arrives, since the Intro renders under the modal's backdrop.
- **`hooksStatus` is install state, `hooksEnabled` is preference.** The Settings checkboxes (one per provider: hooks, status line) bind to `hooksInstalled[providerId]` and toggle the _displayed_ state with no optimistic local update, so it can't read "on" over an untouched settings.json and lands correct rather than flickering when an install fails. Every failure path re-derives and broadcasts the truth (standalone via `clientMessageHandler`, VS Code via `reportHooksStatus`). The bundled scripts are copied BEFORE any provider's install writes; a failed copy aborts it (entries pointing at a missing script spawn a dead `node` per event, and a wrapper pointing at one blanks the status line, which is why `installStatusline` also refuses when the wrapper is not on disk). **Hooks-off is persisted only AFTER a successful uninstall** — flipping it first strands the user: the entries keep firing while the persisted preference makes the next start skip the gate entirely.
- **Never rewrite a shape we did not author.** The unparseable-file abort generalizes: a non-object `hooks`, a non-array `hooks.<Event>`, and junk entries inside an event array are all refused or passed through, never replaced. An array `hooks` was the sharp case — string keys assigned onto it vanish from `JSON.stringify`, so the write committed and reported `installed: true` over a file with no hooks in it. Emptied event keys are deleted only when _our_ removal emptied them. **Internal sentinels must not be values user JSON can hold**: `null` marked "this entry is now empty", so a user-authored `null` inside a hooks array was silently deleted (a file with no Pixel Agents command anywhere came back rewritten and logged as "Hooks removed") — it is a `Symbol` now.
- **Hook identity is anchored at both ends, not a substring.** `includes('claude-hook.js') && includes('.pixelmates')` claimed — and `uninstallHooks` then DELETED — a `.backup` copy of our script, a shell comment naming our path, a wrapper passing it as an argument, `/opt/evil.pixelmates/hooks/claude-hook.js`, and `my-pixel-agents-hook.js`. Ours = the `/.pixelmates/hooks/claude-hook.js` suffix, ending the command's FIRST token, matched **case-insensitively** (the token is normalized to lower case). Case-sensitive matching is what shipped, and on the case-insensitive volumes this runs on (macOS, Windows) a differently-cased path is the SAME INODE as our script and genuinely firing: reinstall appended a duplicate and uninstall left the cased entry as an orphan our own `areHooksInstalled` could no longer see — a live hook with no removal route. The folding is unconditional (no filesystem case-sensitivity probe), so the accepted trade is a Linux-only false positive that is **not** a mere dedup: on a case-sensitive volume `~/.Pixel-Agents/hooks/claude-hook.js` is a genuinely DIFFERENT file, we classify it as ours, and uninstall **deletes** it (`claudeHookInstaller.test.ts` pins that removal). Nothing creates that path, and the trade is deliberate — the alternative is a guaranteed unremovable live hook on the two platforms this actually ships to. A symlink alias to our script is deliberately _not_ recognized — the cost is one duplicate entry, versus deleting a stranger's hook if we resolved paths.
- **E2E over webview unit tests** for OSS friction. Community PRs change webview internals constantly; unit tests would force contributors to update internals tests on top of feature work. E2E pins user-facing behavior, which is stable across internal refactors.

## Project Identity

- npm package: `pixelmates` (CLI bin: `pixelmates`); the VS Code extension is not published
- Data dir: `~/.pixelmates`; `migrateDataDir.ts` copies the office once from upstream's `~/.pixel-agents`
- GitHub: `https://github.com/gustavoortega/pixelmates` (fork of `pixel-agents-hq/pixel-agents`)
- License: MIT

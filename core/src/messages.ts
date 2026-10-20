/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run `npm run asyncapi:generate` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml.
 * Editors and clients in any language can consume the spec directly.
 */

export type ServerMessage =
  | ProviderCapabilities
  | AgentCreated
  | AgentClosed
  | AgentSelected
  | ExistingAgents
  | HandshakeDone
  | AgentStatus
  | AgentToolStart
  | AgentToolDone
  | AgentToolsClear
  | AgentToolPermission
  | AgentToolPermissionClear
  | SubagentToolStart
  | SubagentToolDone
  | SubagentClear
  | SubagentPresent
  | SubagentToolPermission
  | AgentTeamInfo
  | AgentContextUsage
  | AgentModel
  | AgentSessionTitle
  | AgentCache
  | AgentMode
  | AgentShells
  | AgentTripwire
  | AgentTripwireClear
  | AgentHealth
  | AgentHealthClear
  | AgentSession
  | AgentArtifacts
  | AgentLoop
  | AgentTests
  | WorkflowRun
  | AgentRoster
  | RosterEvent
  | LayoutLoaded
  | FurnitureAssetsLoaded
  | CharacterSpritesLoaded
  | PetSpritesLoaded
  | FloorTilesLoaded
  | WallTilesLoaded
  | CarpetTilesLoaded
  | SettingsLoaded
  | HooksStatus
  | HooksConsentRequest
  | ExternalAssetDirectoriesUpdated
  | AreaMappingsLoaded
  | WorkspaceFolders
  | TokenUsage
  | UsageLimits
  | AgentDiagnostics;

export type ClientMessage =
  | WebviewReady
  | LaunchAgent
  | FocusAgent
  | CloseAgent
  | SaveAgentSeats
  | SaveLayout
  | SetSoundEnabled
  | SetLastSeenVersion
  | SetAlwaysShowLabels
  | SetGhostHeadlessAgents
  | SetShowModelFlair
  | SetCozyLighting
  | SetHooksEnabled
  | HooksConsentResponse
  | SetHooksInfoShown
  | SetWatchAllSessions
  | ExportLayout
  | ImportLayout
  | OpenSessionsFolder
  | AddExternalAssetDirectory
  | RemoveExternalAssetDirectory
  | SaveAreaMappings
  | SetShowAreas
  | RequestDiagnostics
  | AckTripwire
  | SetTokenBudgets;

export interface ProviderCapabilities {
  type: 'providerCapabilities';
  readingTools: string[];
  subagentToolNames: string[];
}

export interface AgentCreated {
  type: 'agentCreated';
  id: number;
  folderName?: string;
  isExternal?: boolean;
  palette?: number;
  hueShift?: number;
  isTeammate?: boolean;
  teammateName?: string;
  parentAgentId?: number;
  teamName?: string;
  hooksOnly?: boolean;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface AgentSelected {
  type: 'agentSelected';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<string, AgentSeatMeta>;
  folderNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
}

export interface AgentSeatMeta {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

export interface HandshakeDone {
  type: 'handshakeDone';
}

export interface AgentStatus {
  type: 'agentStatus';
  id: number;
  status: AgentActivityStatus;
  awaitingInput?: boolean;
  awaitingReason?: AwaitingReason;
  question?: string;
  since?: number;
}

export type AgentActivityStatus = 'active' | 'waiting' | 'idle';

export type AwaitingReason = 'question' | 'idle';

export interface AgentToolStart {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  toolName?: string;
  permissionActive?: boolean;
  permissionSince?: number;
  runInBackground?: boolean;
  isTeammateSpawn?: boolean;
}

export interface AgentToolDone {
  type: 'agentToolDone';
  id: number;
  toolId: string;
}

export interface AgentToolsClear {
  type: 'agentToolsClear';
  id: number;
}

export interface AgentToolPermission {
  type: 'agentToolPermission';
  id: number;
  permissionSince?: number;
}

export interface AgentToolPermissionClear {
  type: 'agentToolPermissionClear';
  id: number;
}

export interface SubagentToolStart {
  type: 'subagentToolStart';
  id: number;
  parentToolId: string;
  toolId: string;
  status: string;
  label?: string;
  group?: string;
}

export interface SubagentToolDone {
  type: 'subagentToolDone';
  id: number;
  parentToolId: string;
  toolId: string;
}

export interface SubagentClear {
  type: 'subagentClear';
  id: number;
  parentToolId: string;
}

export interface SubagentPresent {
  type: 'subagentPresent';
  id: number;
  parentToolId: string;
  label?: string;
  group?: string;
}

export interface SubagentToolPermission {
  type: 'subagentToolPermission';
  id: number;
  parentToolId: string;
}

export interface AgentTeamInfo {
  type: 'agentTeamInfo';
  id: number;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface AgentContextUsage {
  type: 'agentContextUsage';
  id: number;
  contextTokens: number;
  maxContextTokens: number;
}

export interface AgentModel {
  type: 'agentModel';
  id: number;
  model?: string;
  tier?: number;
}

export interface AgentSessionTitle {
  type: 'agentSessionTitle';
  id: number;
  title?: string;
}

export interface AgentCache {
  type: 'agentCache';
  id: number;
  ttlSeconds?: CacheTtlSeconds;
  expiresAt?: number;
}

export type CacheTtlSeconds = 300 | 3600;

export interface AgentMode {
  type: 'agentMode';
  id: number;
  mode?: PermissionMode;
}

export type PermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk';

export interface AgentShells {
  type: 'agentShells';
  id: number;
  running: number;
}

export interface AgentTripwire {
  type: 'agentTripwire';
  id: number;
  ruleId: string;
  ruleName: string;
  severity: TripwireSeverity;
  count: number;
  since?: number;
}

export type TripwireSeverity = 'high' | 'medium' | 'low';

export interface AgentTripwireClear {
  type: 'agentTripwireClear';
  id: number;
}

export interface AgentHealth {
  type: 'agentHealth';
  id: number;
  state: HealthState;
  reason: HealthReason;
  count: number;
  since?: number;
}

export type HealthState = 'stuck' | 'stalled' | 'looping' | 'dead';

export type HealthReason =
  'tests_failing_no_edits' | 'no_progress' | 'same_call_repeated' | 'process_gone';

export interface AgentHealthClear {
  type: 'agentHealthClear';
  id: number;
}

export interface AgentSession {
  type: 'agentSession';
  id: number;
  startedAt?: number;
  branch?: string;
  sessionId8?: string;
  costUsd?: number;
  costAt?: number;
}

export interface AgentArtifacts {
  type: 'agentArtifacts';
  id: number;
  count?: number;
  complete?: boolean;
  items?: ArtifactItem[];
}

export interface ArtifactItem {
  title?: string;
  url?: string;
  publishes?: number;
  at?: number;
}

export interface AgentLoop {
  type: 'agentLoop';
  id: number;
  nextAt?: number;
  wakes?: number;
}

export interface AgentTests {
  type: 'agentTests';
  id: number;
  passed?: number;
  failed?: number;
  at?: number;
}

export interface WorkflowRun {
  type: 'workflowRun';
  id: number;
  runId: string;
  status?: WorkflowRunStatus;
  name?: string;
  phases?: WorkflowPhase[];
  started?: number;
  done?: number;
  since?: number;
}

export type WorkflowRunStatus = 'running' | 'done';

export interface WorkflowPhase {
  name?: string;
  started?: number;
  done?: number;
}

export interface AgentRoster {
  type: 'agentRoster';
  id: number;
  memberId: string;
  name: string;
  level: number;
  xp: number;
  xpToNext: number;
  streak: number;
  mood: RosterMood;
}

export type RosterMood = 'alarmed' | 'frustrated' | 'happy' | 'neutral';

export interface RosterEvent {
  type: 'rosterEvent';
  id: number;
  kind: RosterEventKind;
  amount?: number;
  level?: number;
  signal?: RosterEventSignal;
}

export type RosterEventKind = 'xp' | 'levelUp';

export type RosterEventSignal = 'commit' | 'pr' | 'merge' | 'tests';

export interface LayoutLoaded {
  type: 'layoutLoaded';
  layout: Record<string, any> | null;
  wasReset?: boolean;
  imported?: boolean;
}

export interface FurnitureAssetsLoaded {
  type: 'furnitureAssetsLoaded';
  catalog: FurnitureAssetMessage[];
  sprites: Record<string, string[][]>;
}

export interface FurnitureAssetMessage {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface CharacterSpritesLoaded {
  type: 'characterSpritesLoaded';
  characters: CharacterSpriteSet[];
}

export interface CharacterSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface PetSpritesLoaded {
  type: 'petSpritesLoaded';
  pets: PetSpriteFrameSet[];
  petNames: string[];
}

export interface PetSpriteFrameSet {
  walkDown: string[][][];
  idleDown: string[][][];
  walkUp: string[][][];
  idleUp: string[][][];
  walkRight: string[][][];
}

export interface FloorTilesLoaded {
  type: 'floorTilesLoaded';
  sprites: string[][][];
}

export interface WallTilesLoaded {
  type: 'wallTilesLoaded';
  sets: string[][][][];
}

export interface CarpetTilesLoaded {
  type: 'carpetTilesLoaded';
  sets: string[][][][];
}

export interface SettingsLoaded {
  type: 'settingsLoaded';
  soundEnabled: boolean;
  lastSeenVersion: string;
  extensionVersion: string;
  watchAllSessions: boolean;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  showModelFlair: boolean;
  cozyLighting: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  externalAssetDirectories: string[];
  showAreas: boolean;
}

export interface HooksStatus {
  type: 'hooksStatus';
  providerId: string;
  installed: boolean;
}

export interface HooksConsentRequest {
  type: 'hooksConsentRequest';
  providerId: string;
  headline: string;
  disclosure: string;
}

export interface ExternalAssetDirectoriesUpdated {
  type: 'externalAssetDirectoriesUpdated';
  dirs: string[];
}

export interface AreaMappingsLoaded {
  type: 'areaMappingsLoaded';
  mappings: Record<string, string[]>;
}

export interface WorkspaceFolders {
  type: 'workspaceFolders';
  folders: WorkspaceFolder[];
}

export interface WorkspaceFolder {
  name: string;
  path: string;
}

export interface TokenUsage {
  type: 'tokenUsage';
  generatedAt: number;
  scanning?: boolean;
  block?: TokenWindow;
  week?: TokenWindow;
  biggestBlock?: number;
  budget5h?: number;
  budgetWeek?: number;
}

export interface TokenWindow {
  source: TokenWindowSource;
  start: number;
  end: number;
  total: number;
  raw: number;
  budgetPct?: number;
  byArea: TokenAreaTotal[];
  bySession: TokenSessionTotal[];
}

export type TokenWindowSource = 'quota' | 'estimated';

export interface TokenAreaTotal {
  area: string | null;
  folder: string;
  total: number;
  raw: number;
  share?: number;
  budgetPct?: number;
}

export interface TokenSessionTotal {
  sessionId: string;
  title?: string;
  area: string | null;
  folder: string;
  total: number;
  raw: number;
  models: Record<string, number>;
  rawModels: Record<string, number[]>;
}

export interface UsageLimits {
  type: 'usageLimits';
  receivedAt: number;
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
}

export interface LimitWindow {
  usedPercentage: number;
  resetsAt: number;
}

export interface AgentDiagnostics {
  type: 'agentDiagnostics';
  agents: Record<string, any>[];
}

export interface WebviewReady {
  type: 'webviewReady';
}

export interface LaunchAgent {
  type: 'launchAgent';
  folderPath?: string;
  bypassPermissions?: boolean;
}

export interface FocusAgent {
  type: 'focusAgent';
  id: number;
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
}

export interface SaveAgentSeats {
  type: 'saveAgentSeats';
  seats: Record<string, SeatAssignment>;
}

export interface SeatAssignment {
  palette: number;
  hueShift: number;
  seatId: string | null;
}

export interface SaveLayout {
  type: 'saveLayout';
  layout: Record<string, any>;
}

export interface SetSoundEnabled {
  type: 'setSoundEnabled';
  enabled: boolean;
}

export interface SetLastSeenVersion {
  type: 'setLastSeenVersion';
  version: string;
}

export interface SetAlwaysShowLabels {
  type: 'setAlwaysShowLabels';
  enabled: boolean;
}

export interface SetGhostHeadlessAgents {
  type: 'setGhostHeadlessAgents';
  enabled: boolean;
}

export interface SetShowModelFlair {
  type: 'setShowModelFlair';
  enabled: boolean;
}

export interface SetCozyLighting {
  type: 'setCozyLighting';
  enabled: boolean;
}

export interface SetHooksEnabled {
  type: 'setHooksEnabled';
  providerId: string;
  enabled: boolean;
}

export interface HooksConsentResponse {
  type: 'hooksConsentResponse';
  providerId: string;
  choice: HooksConsentChoice;
}

export type HooksConsentChoice = 'install' | 'notNow' | 'never';

export interface SetHooksInfoShown {
  type: 'setHooksInfoShown';
}

export interface SetWatchAllSessions {
  type: 'setWatchAllSessions';
  enabled: boolean;
}

export interface ExportLayout {
  type: 'exportLayout';
}

export interface ImportLayout {
  type: 'importLayout';
}

export interface OpenSessionsFolder {
  type: 'openSessionsFolder';
}

export interface AddExternalAssetDirectory {
  type: 'addExternalAssetDirectory';
  path?: string;
}

export interface RemoveExternalAssetDirectory {
  type: 'removeExternalAssetDirectory';
  path: string;
}

export interface SaveAreaMappings {
  type: 'saveAreaMappings';
  mappings: Record<string, string[]>;
}

export interface SetShowAreas {
  type: 'setShowAreas';
  enabled: boolean;
}

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}

export interface AckTripwire {
  type: 'ackTripwire';
  id: number;
  count: number;
}

export interface SetTokenBudgets {
  type: 'setTokenBudgets';
  budget5h?: number;
  budgetWeek?: number;
}

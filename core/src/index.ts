// Core package: shared types, interfaces, and protocol definitions
// Everything in this package is types-only (no runtime behavior)

export type { StateAdapter } from './adapter.js';
export {
  HOOK_API_PREFIX,
  HOOK_SCRIPTS_DIR,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  SESSION_TITLE_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from './constants.js';
export type { ClientMessage, FurnitureAssetMessage, ServerMessage } from './messages.js';
export type {
  AgentEvent,
  HookInstallOptions,
  HookProvider,
  ModelTier,
  SessionMetaFacts,
} from './provider.js';
export type {
  AgentMeta,
  ColorValue,
  Disposable,
  FloorColor,
  FurnitureCatalogEntry,
  HookEvent,
  OfficeLayout,
  PersistedAgent,
  PlacedFurniture,
  SpriteData,
} from './schemas.js';
export type { TeamProvider } from './teamProvider.js';

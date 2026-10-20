import type { HookInstallOptions, HookProvider } from '../../../../../core/src/provider.js';
import {
  hasUpstreamStatusline,
  installStatusline,
  isStatuslineInstalled,
  STATUSLINE_UNSUPPORTED_PLATFORM,
  uninstallStatusline,
} from './claudeStatuslineInstaller.js';
import {
  LEGACY_REPLACE_LABEL,
  STATUSLINE_CONSENT_DISCLOSURE,
  STATUSLINE_CONSENT_HEADLINE,
} from './consentCopy.js';

/**
 * Claude Code's status line wrapper as a second provider. It installs no hooks: its "install" chains
 * statusline-tee.js in front of the user's statusLine command, which reports the official 5-hour and weekly limits
 * to POST /api/statusline/claude-statusline. Being a provider is what lets it reuse the whole consent machinery (the
 * gate, the executor and its queue, the per-provider config records, the wire messages, the webview's ask queue)
 * unchanged; every member that only makes sense for hook events is inert. Off until the user turns it on.
 */

const NONE: ReadonlySet<string> = new Set();

export const claudeStatuslineProvider: HookProvider = {
  kind: 'hook',
  id: 'claude-statusline',
  displayName: 'Claude Code status line',
  protocolVersion: 1,
  defaultEnabled: false,

  // No hook events: the wrapper posts to its own route, never /api/hooks.
  normalizeHookEvent: () => null,

  async installHooks(
    _serverUrl: string,
    _authToken: string,
    options?: HookInstallOptions,
  ): Promise<void> {
    // The wrapper runs the original command through `sh`, so the install would
    // break a cmd.exe status line. Refuse before anything is written.
    if (process.platform === 'win32') throw new Error(STATUSLINE_UNSUPPORTED_PLATFORM);
    await installStatusline(options);
  },
  uninstallHooks: () => uninstallStatusline(),
  areHooksInstalled: () => Promise.resolve(isStatuslineInstalled()),
  legacyReplaceLabel: () => (hasUpstreamStatusline() ? LEGACY_REPLACE_LABEL : null),
  consentDisclosure: () => ({
    headline: STATUSLINE_CONSENT_HEADLINE,
    disclosure: STATUSLINE_CONSENT_DISCLOSURE,
  }),

  formatToolStatus: (toolName) => toolName,
  permissionExemptTools: NONE,
  subagentToolNames: NONE,
  readingTools: NONE,
};

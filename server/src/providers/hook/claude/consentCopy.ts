/**
 * Disclosure text for the hooks consent gate. Both surfaces show the SAME
 * in-app ask: the server ships these strings in the `hooksConsentRequest`
 * message and the webview's IntroBubble (the greeter character's speech
 * bubble) renders them verbatim on the Intro's consent step, so there is
 * exactly one copy of the terms and no client-side duplicate to drift into
 * asking for approval on weaker terms.
 *
 * Two pieces: the HEADLINE is the title of the Intro's consent step and the
 * DISCLOSURE is that step's body. The headline carries NO disclosure facts —
 * every fact lives in the shared disclosure block, so no fact depends on how a
 * surface renders its title slot (consentCopy.test.ts pins that split).
 *
 * The event count is interpolated from CLAUDE_HOOK_EVENTS, never written out:
 * a hardcoded number silently becomes a lie the next time the list changes.
 */

import { CLAUDE_HOOK_EVENTS, SETTINGS_BACKUP_SUFFIX } from './constants.js';

const SETTINGS_FILE = '~/.claude/settings.json';

/** WHY we ask + WHAT we write. */
export const CONSENT_FACT_WHAT =
  `To bring your agents to life in real time, pixelmates adds hooks for ` +
  `${CLAUDE_HOOK_EVENTS.length} Claude Code events to ${SETTINGS_FILE}. ` +
  `Note that your existing settings are kept, and a one-time backup is saved as settings.json${SETTINGS_BACKUP_SUFFIX}.`;

/** WHAT data moves, and where it stops.
 *
 *  "Nothing leaves your machine" is not something this prompt can promise:
 *  `npx pixelmates --host 0.0.0.0` binds the same server to every interface,
 *  and an accepted socket receives the store broadcasts
 *  (server/src/httpServer.ts). So it states the default and names the one
 *  thing that changes it, rather than making a promise the software can be
 *  asked to break. */
export const CONSENT_FACT_DATA =
  'Claude Code will send those events - including tool names and tool inputs - to a pixelmates ' +
  'server on this machine. Everything stays local - the server listens only on 127.0.0.1 - unless ' +
  'you explicitly start it with --host to expose it on your network.';

/** HOW to undo it. */
export const CONSENT_FACT_REVERSIBLE =
  'You can remove the hooks at any time from Settings → Instant Detection (Hooks).';

/** Headline for the first-run gate — the only population that is asked. A user
 *  whose hooks a pre-consent version already installed is migrated silently
 *  (the migration only ever drops events), so there is no second headline.
 *  Title of the Intro's consent step ("Welcome to pixelmates!" is the
 *  Intro's own opening-step title, owned by the webview). Carries NO
 *  disclosure facts by design: the facts all live in CONSENT_DISCLOSURE. */
export const CONSENT_INSTALL_HEADLINE = 'One more thing: hooks!';

/** The three disclosure facts, in order, as one block.
 *
 *  This is the consent step's body. The IntroBubble splits it on the blank
 *  lines and renders every paragraph in full on the decision surface itself — no
 *  "Details" affordance, which would put the disclosure one click away from
 *  the decision it is there to inform. */
export const CONSENT_DISCLOSURE = [
  CONSENT_FACT_WHAT,
  CONSENT_FACT_DATA,
  CONSENT_FACT_REVERSIBLE,
].join('\n\n');

/** The consent dialog's second checkbox, default off, shown only when upstream Pixel Agents' entries are found in the
 *  same settings.json. It is the one place the upstream brand is spelled out: that is the app being replaced. */
export const LEGACY_REPLACE_LABEL = 'Replace Pixel Agents hooks (Pixel Agents stops updating)';

// ── The status line wrapper (provider 'claude-statusline') ──
// Static text on purpose, no interpolation: these facts describe what the
// wrapper does, and none of them varies with configuration.

/** Title of the consent step for the official usage limits. */
export const STATUSLINE_CONSENT_HEADLINE = "Read Claude Code's official usage limits?";

/** WHAT changes, and what stays the user's. */
const STATUSLINE_CONSENT_FACT_WHAT =
  'pixelmates wraps statusLine.command in ~/.claude/settings.json with ' +
  '~/.pixelmates/hooks/statusline-tee.js. Your command, its output and its exit code are untouched. ' +
  'Like the hooks, it needs `node` on your PATH, and it takes effect in your next Claude Code session.';

/** WHAT is sent, and what never is. */
const STATUSLINE_CONSENT_FACT_DATA =
  'On each status line refresh, only rate_limits.five_hour and rate_limits.seven_day (used percentage and ' +
  'reset time) go to the pixelmates server on 127.0.0.1. Nothing else from the status line input is sent: ' +
  'no working directory, model, session, cost or transcript path.';

/** HOW to undo it, including when the app is gone first. */
const STATUSLINE_CONSENT_FACT_REVERSIBLE =
  'Turning it off in Settings restores your original command exactly. If you remove pixelmates first, ' +
  'the wrapper keeps running your command unchanged, and the original stays readable inside the command.';

/** The status line ask's body: three paragraphs, split on the blank lines like the hooks disclosure. */
export const STATUSLINE_CONSENT_DISCLOSURE = [
  STATUSLINE_CONSENT_FACT_WHAT,
  STATUSLINE_CONSENT_FACT_DATA,
  STATUSLINE_CONSENT_FACT_REVERSIBLE,
].join('\n\n');

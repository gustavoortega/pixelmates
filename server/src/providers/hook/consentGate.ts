/**
 * The first-run hooks consent POLICY: when to ask, and what an answer means. Provider-agnostic — the provider
 * contributes only its id and disclosure copy, and the storage is keyed per provider. Written once rather than once
 * per surface: a duplicated gate drifts silently, and a settings file in the user's home directory is on the other
 * side of it. The full rule, with its rejected alternatives, is docs/adr/0001.
 */

import type { HooksConsentRequest } from '../../../../core/src/messages.js';
import type { HookProvider } from '../../../../core/src/provider.js';

/** Inputs to the ask-or-not decision, as each surface already knows them. */
export interface ConsentGateState {
  /** Are any of this provider's hook commands on disk right now
   *  (areHooksInstalled)? */
  installed: boolean;
  /** The provider's persisted hooks preference, or its default when nothing
   *  is recorded. Claude's default is true, so it is only false after an
   *  explicit decline or a Settings toggle-off; a provider that is off by
   *  default (the status line wrapper) is therefore never asked here until a
   *  Settings toggle-on records the preference. */
  hooksEnabled: boolean;
  /** Has this provider's ask been durably answered (config.json
   *  hooksConsent[providerId] holds 'granted' or 'declined')? */
  consentAnswered: boolean;
  /** May this client's answer actually be acted on? Embedded webviews are
   *  privileged by construction; a standalone connection must have proved the
   *  server token. Showing the dialog to a client whose answer would be
   *  ignored is a lie, so it gates the ASK and not just the response. */
  privileged: boolean;
}

/**
 * The `hooksConsentRequest` for one provider's `webviewReady` handshake, or null when this client must not be asked.
 * Each condition is a reason the ask would be WRONG, not merely redundant: nothing to approve, already answered
 * durably, a preference turned off, or a client whose answer would be dropped. All four are checked in their own
 * right, so a hand-edited config cannot resurrect a retired ask.
 */
export function hooksConsentRequest(
  state: ConsentGateState,
  provider: Pick<HookProvider, 'id' | 'consentDisclosure' | 'legacyReplaceLabel'>,
): HooksConsentRequest | null {
  if (state.installed || state.consentAnswered || !state.hooksEnabled || !state.privileged) {
    return null;
  }
  const { headline, disclosure } = provider.consentDisclosure();
  // Only when the other app's entries are on disk: the dialog then offers the second, default-off checkbox.
  const replaceLegacyLabel = provider.legacyReplaceLabel?.() ?? null;
  return {
    type: 'hooksConsentRequest',
    providerId: provider.id,
    headline,
    disclosure,
    ...(replaceLegacyLabel === null ? {} : { replaceLegacyLabel }),
  };
}

/**
 * Whether a Settings toggle must ask before it installs. Only an off-by-default provider (the status line wrapper)
 * asks: its toggle-on over an unanswered ask records the preference and sends the same `hooksConsentRequest` the
 * handshake would, instead of writing the settings file; Install then installs through the executor, "Not Now" takes
 * the preference back. The hooks keep ADR 0001's rule: their toggle click is the grant. An answered ask, granted or
 * declined, keeps the direct install, and turning off never asks.
 */
export function toggleNeedsConsent(
  enabled: unknown,
  consent: 'granted' | 'declined' | 'unanswered',
  defaultEnabled: boolean | undefined,
): boolean {
  return enabled === true && consent === 'unanswered' && defaultEnabled === false;
}

/** What the server should DO about an answer. The Intro lets the user walk BACK from the closing step and re-answer,
 *  so a choice is an absolute statement of desired state, not a one-shot event: a decline maps to whichever action
 *  UNDOES what the earlier answer left (hooks on disk, a recorded grant, or a decline's own hooks-off). Rationale and
 *  rejected alternatives: docs/adr/0001; consentExecutor.ts performs each arm. */
export type ConsentAction =
  'install' | 'persistOff' | 'disable' | 'revert' | 'revertDecline' | 'none';

/** What an earlier answer may have left behind, as the surface reads it when
 *  the next answer arrives. */
export interface ConsentRevisionState {
  /** Are any of this provider's hook commands on disk right now
   *  (areHooksInstalled)? Callers that cannot read it pass false — the file is
   *  then never touched on a guess. */
  installed: boolean;
  /** The provider's durable consent record — a TRI-STATE, not a boolean, because each value is a different thing to
   *  undo. `granted` can exist with nothing on disk (install records the grant BEFORE it writes, and the write can
   *  fail; keying the revert off `installed` stranded exactly that user), and `declined` carries the provenance that
   *  the persisted hooks-off was the ANSWER's own write, which a revised "not now" takes back with it. */
  consent: 'granted' | 'declined' | 'unanswered';
  /** The preference is recorded ON for a provider that is off by default (hooksPreferenceRaisedFromDefault): a
   *  Settings toggle asked first and wrote it. With nothing answered, that preference is the only thing the ask left
   *  behind, so a "Not Now" takes it back like a decline's own hooks-off. Absent = false. */
  preferenceRaised?: boolean;
}

/**
 * Fail-closed on exact matches: only literal `'install'` approves and only literal `'never'` declines durably.
 * `'notNow'`, a dismissal that sends nothing, a truncated payload and any crafted value fall through to the no-write
 * actions. `unknown` is the honest type for `choice` — this runs on a wire message, and narrowing it is the point.
 */
export function consentActionFor(choice: unknown, state: ConsentRevisionState): ConsentAction {
  if (choice === 'install') return 'install';
  if (choice === 'never') return state.installed ? 'disable' : 'persistOff';
  if (choice === 'notNow') {
    if (state.consent === 'declined') return 'revertDecline';
    if (state.installed || state.consent === 'granted') return 'revert';
    // A toggle-on that asked first: the recorded preference is the toggle's own write, so "Not Now" restores the
    // default rather than leaving an ask that would then come back on every handshake.
    if (state.preferenceRaised === true) return 'revertDecline';
    return 'none';
  }
  return 'none';
}

/**
 * The browser tab's badge: how many agents need an answer, in the title and on the favicon.
 * Pure: the hook that touches the document lives in hooks/useTabBadge.ts.
 */

import type { Attention } from './components/attention.js';

export const TAB_NAME = 'pixelmates';

/** The tab title: `(2) pixelmates` while someone needs you, the plain name otherwise. */
export function tabTitle(count: number): string {
  return count > 0 ? `(${count}) ${TAB_NAME}` : TAB_NAME;
}

/**
 * Who counts: permission prompts and questions. Stuck sessions and finished ones (Your turn) stay
 * out, so the badge means "an agent is blocked on you right now".
 */
export function badgeCount(attention: Attention): number {
  return attention.needs.length;
}

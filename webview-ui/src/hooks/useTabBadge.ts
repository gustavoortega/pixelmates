import { useEffect } from 'react';

import {
  TAB_BADGE_DOT_COLOR,
  TAB_BADGE_DOT_RADIUS,
  TAB_BADGE_RING_COLOR,
  TAB_BADGE_RING_WIDTH,
  TAB_ICON_PX,
} from '../constants.js';
import { isBrowserRuntime } from '../runtime.js';
import { tabTitle } from '../tabBadge.js';

/** The favicon as the page shipped it, and the loaded icon once it is in. */
let baseHref: string | null = null;
let icon: HTMLImageElement | null = null;
let iconLoading = false;
let latestCount = 0;

function iconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
}

/** The icon (or an ink square while it loads) with the gold badge dot at the bottom right. */
function badgedHref(img: HTMLImageElement | null): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = TAB_ICON_PX;
    canvas.height = TAB_ICON_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (img) {
      ctx.drawImage(img, 0, 0, TAB_ICON_PX, TAB_ICON_PX);
    } else {
      ctx.fillStyle = TAB_BADGE_RING_COLOR;
      ctx.fillRect(0, 0, TAB_ICON_PX, TAB_ICON_PX);
    }
    const r = TAB_BADGE_DOT_RADIUS * TAB_ICON_PX;
    const ring = TAB_BADGE_RING_WIDTH * TAB_ICON_PX;
    const cx = TAB_ICON_PX - r - ring;
    ctx.fillStyle = TAB_BADGE_RING_COLOR;
    ctx.beginPath();
    ctx.arc(cx, cx, r + ring, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = TAB_BADGE_DOT_COLOR;
    ctx.beginPath();
    ctx.arc(cx, cx, r, 0, Math.PI * 2);
    ctx.fill();
    return canvas.toDataURL('image/png');
  } catch {
    // A tainted or unavailable canvas leaves the plain icon: the title still carries the count.
    return null;
  }
}

function applyFavicon(): void {
  const link = iconLink();
  if (!link) return;
  if (baseHref === null) baseHref = link.getAttribute('href') ?? '';
  if (latestCount <= 0) {
    link.setAttribute('href', baseHref);
    return;
  }
  const href = badgedHref(icon);
  if (href) link.setAttribute('href', href);
  if (!icon && !iconLoading && baseHref) {
    iconLoading = true;
    const img = new Image();
    img.onload = () => {
      icon = img;
      if (latestCount > 0) applyFavicon();
    };
    img.onerror = () => {
      iconLoading = false;
    };
    img.src = baseHref;
  }
}

/**
 * The browser tab shows how many agents need you: `(2) pixelmates` and a gold dot on the icon.
 * Browser only: a VS Code webview has no tab.
 */
export function useTabBadge(count: number): void {
  useEffect(() => {
    if (!isBrowserRuntime) return;
    latestCount = count;
    document.title = tabTitle(count);
    applyFavicon();
  }, [count]);
}

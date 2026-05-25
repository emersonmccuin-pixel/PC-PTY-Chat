// Anchor state for the floating <RichLinkPreviewCard>. ChatSurface's hover
// handlers populate via show/hide; the card mounted at Shell level renders
// when (anchor && url && projectId) and reads the data via useRichLinkData.
//
// Debouncing lives outside the store — see scheduleShow / scheduleHide
// below. Pattern keeps the store stupid (current state only) and lets the
// handlers stay declarative.

import { create } from 'zustand';

interface RichLinkPreviewState {
  anchor: HTMLElement | null;
  url: string | null;
  projectId: string | null;
  show: (anchor: HTMLElement, url: string, projectId: string) => void;
  hide: () => void;
}

export const useRichLinkPreview = create<RichLinkPreviewState>((set) => ({
  anchor: null,
  url: null,
  projectId: null,
  show: (anchor, url, projectId) => set({ anchor, url, projectId }),
  hide: () => set({ anchor: null, url: null, projectId: null }),
}));

// Debounce timers — module-scoped so multiple links coordinate.
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const SHOW_DELAY_MS = 150;
const HIDE_DELAY_MS = 200;

function clearTimers(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

export function scheduleRichLinkShow(
  anchor: HTMLElement,
  url: string,
  projectId: string,
): void {
  clearTimers();
  showTimer = setTimeout(() => {
    useRichLinkPreview.getState().show(anchor, url, projectId);
    showTimer = null;
  }, SHOW_DELAY_MS);
}

export function scheduleRichLinkHide(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    useRichLinkPreview.getState().hide();
    hideTimer = null;
  }, HIDE_DELAY_MS);
}

/** Called when the user enters the preview card itself — cancels the pending
 *  hide so the card stays open while the cursor is inside it. */
export function cancelRichLinkHide(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

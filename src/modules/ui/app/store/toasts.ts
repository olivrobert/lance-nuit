// The one toast on screen, its timer, and the clipboard that reports through it.

import type { StoreCore } from "./core.js";

/** How long a toast stays on screen. */
const TOAST_MS = 6000;

export interface Toasts {
  /** Show `message`, replacing the toast on screen and restarting its timer. */
  show(message: string): void;
  /** Copy to the clipboard, falling back to showing the value: over a tunnel
   *  the page is plain HTTP, where `navigator.clipboard` may not exist at all,
   *  and a reader who can read the string can still select it. */
  copy(value: string): Promise<void>;
}

export function createToasts(core: StoreCore): Toasts {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  function show(message: string): void {
    seq += 1;
    if (timer !== null) clearTimeout(timer);
    core.set({ toast: { id: seq, message } });
    timer = setTimeout(() => {
      timer = null;
      core.set({ toast: null });
    }, TOAST_MS);
  }

  return {
    show,
    async copy(value) {
      try {
        await navigator.clipboard.writeText(value);
        show("Copied.");
      } catch {
        show(value);
      }
    },
  };
}

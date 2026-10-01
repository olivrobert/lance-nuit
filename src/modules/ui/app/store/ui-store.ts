// What the reader holds that neither the server nor the address knows.
//
// The server's answers live in the query cache (`api/queries.ts`) and where the
// reader is lives in the URL (`router.tsx`). What is left is small and owned
// here, each piece for a reason:
//
//   `query`       the search text. Several zones read it — the box, the list,
//                 the keyboard — and typing must never be undone by a poll.
//   `replies`     draft answers by item key: the textarea that holds one may be
//                 unmounted by a tab switch, and a draft must survive it.
//   `openDirs`    explorer directories the reader opened, by item key, so they
//                 survive a poll, a tab switch and a trip to another item.
//   `launchLogs`  launch ids whose log the reader opened or closed; the two
//                 places that show a launch share it. An id never toggled
//                 follows the launch: a launch that failed before its run
//                 shows its log.
//   `toast`       the one message on screen.
//   `lastInbox`   the inbox address the reader left, for the links back to it.
//
// Every write goes through an action below; `useUi(selector)` reads a slice and
// re-renders only when that slice changes.

import { create } from "zustand";
import type { InboxAddress } from "../lib/inbox-address.js";

/** How long a toast stays on screen. */
const TOAST_MS = 6000;

export interface Toast {
  /** Monotonic, so an identical message twice in a row still remounts. */
  id: number;
  message: string;
}

interface UiState {
  query: string;
  replies: Readonly<Record<string, string>>;
  openDirs: Readonly<Record<string, readonly string[]>>;
  launchLogs: Readonly<Record<string, boolean>>;
  toast: Toast | null;
  lastInbox: InboxAddress;
}

const NO_DIRS: readonly string[] = [];

export const useUi = create<UiState>(() => ({
  query: "",
  replies: {},
  openDirs: {},
  launchLogs: {},
  toast: null,
  lastInbox: { chip: null, item: null },
}));

/** The directories open in one item's explorer, stable while none is toggled. */
export function openDirsOf(state: UiState, itemKey: string): readonly string[] {
  return state.openDirs[itemKey] ?? NO_DIRS;
}

export function setQuery(query: string): void {
  useUi.setState({ query });
}

export function setReply(itemKey: string, text: string): void {
  useUi.setState((state) => ({ replies: { ...state.replies, [itemKey]: text } }));
}

export function toggleDir(itemKey: string, path: string, open: boolean): void {
  useUi.setState((state) => {
    const current = openDirsOf(state, itemKey);
    if (current.includes(path) === open) return state;
    const next = open ? [...current, path] : current.filter((entry) => entry !== path);
    return { openDirs: { ...state.openDirs, [itemKey]: next } };
  });
}

export function setLaunchLogOpen(launchId: string, open: boolean): void {
  useUi.setState((state) =>
    state.launchLogs[launchId] === open ? state : { launchLogs: { ...state.launchLogs, [launchId]: open } },
  );
}

export function rememberInbox(address: InboxAddress): void {
  const last = useUi.getState().lastInbox;
  if (last.chip === address.chip && last.item === address.item) return;
  useUi.setState({ lastInbox: address });
}

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Show `message`, replacing the toast on screen and restarting its timer. */
export function toast(message: string): void {
  toastSeq += 1;
  if (toastTimer !== null) clearTimeout(toastTimer);
  useUi.setState({ toast: { id: toastSeq, message } });
  toastTimer = setTimeout(() => {
    toastTimer = null;
    useUi.setState({ toast: null });
  }, TOAST_MS);
}

/** Copy to the clipboard, falling back to showing the value: over a tunnel the
 *  page is plain HTTP, where `navigator.clipboard` may not exist at all, and a
 *  reader who can read the string can still select it. */
export async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast("Copied.");
  } catch {
    toast(value);
  }
}

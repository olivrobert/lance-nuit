// The one snapshot, and the only code that replaces it or tells React.
//
// Two ways to write. `set` changes the state and repaints: it answers a reader's
// gesture. `stage` changes it silently, so the poll can assemble a whole new
// screen — identity, projects, items, detail, file — and `commit` then decides
// ONCE, from a signature of what the screen shows, whether anything moved. An
// idle poll therefore costs no re-render.

import type { FileView } from "../api/types.js";
import type { UiState } from "./state.js";

export interface StoreCore {
  /** The current snapshot. Never mutated: every write replaces it. */
  readonly state: UiState;
  subscribe(listener: () => void): () => void;
  /** Change the state and repaint. */
  set(patch: Partial<UiState>): void;
  /** Change the state without repainting yet. */
  stage(patch: Partial<UiState>): void;
  /** Repaint for whatever `stage` accumulated, if it changed anything visible;
   *  `force` repaints regardless. */
  commit(force?: boolean): void;
}

/**
 * The open file, reduced to what a repaint decision needs.
 *
 * `content` carries the whole file, a base64 image included, and hashing it
 * every fifteen seconds costs megabytes for an answer these four fields already
 * give: a file whose path, size, kind and status are unchanged renders the same.
 */
function fileSignature(file: FileView | null): unknown {
  if (!file) return null;
  const view = file as Record<string, unknown>;
  return [view.relativePath ?? null, view.size ?? null, view.contentKind ?? null, view.status ?? view.error ?? null];
}

/** Signature of everything the screen shows. The drafts, the open directories
 *  and the search text are deliberately absent: they are only ever changed by
 *  the reader, and each of those changes commits on its own. */
function signatureOf(next: UiState): string {
  return JSON.stringify([
    next.user,
    next.users,
    next.projects,
    next.items,
    next.filter,
    next.selected,
    next.filePath,
    next.detail,
    fileSignature(next.file),
    next.assumptions,
    next.launchLog,
    next.pending,
    next.loaded,
    next.refreshError,
  ]);
}

export function createCore(initial: UiState): StoreCore {
  let state = initial;
  const listeners = new Set<() => void>();

  /** Signature of the last committed screen. */
  let signature = "";

  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    get state() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    set(patch) {
      state = { ...state, ...patch };
      notify();
    },

    stage(patch) {
      state = { ...state, ...patch };
    },

    commit(force = false) {
      const next = signatureOf(state);
      if (!force && next === signature) return;
      signature = next;
      notify();
    },
  };
}

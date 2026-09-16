// The application's one store, and the React side of it.
//
// The store itself — state, loading, race guard, actions — is built by
// `createUiStore` in `create-store.ts`, which knows nothing about React or
// `fetch`. This module is the composition point: it hands the real API client to
// the factory once, at module load, and exposes the result through the hooks
// below. A test never imports this file; it builds its own store with a fake API.
//
// THE INTEGRATION CONTRACT — what components may use
// --------------------------------------------------
//   useUiState()                the whole snapshot; re-renders on every commit
//   useUiSelector(select, eq?)  one slice; re-renders only when the slice moves
//   useActions()                the action object, stable for the whole session
//   actions                     the same object, for code outside React
//
// Components MUST NOT mutate the snapshot: it is shared, and a mutation would be
// invisible to `useSyncExternalStore`. Every change goes through an action.

import { useCallback, useRef, useSyncExternalStore } from "react";
import * as client from "../api/client.js";
import { createUiStore, type UiActions, type UiState } from "./create-store.js";

export { LOG_LINES, POLL_MS, SEARCH_DEBOUNCE_MS, type Toast, type UiActions, type UiState } from "./create-store.js";

const store = createUiStore(client);

/** The action object, stable for the whole session. */
export const actions: UiActions = store.actions;

// ───────────────────────── React bindings ─────────────────────────

/** The whole snapshot. Convenient, and the right choice for a component that
 *  reads several unrelated fields; prefer `useUiSelector` in a list row. */
export function useUiState(): UiState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * One derived slice.
 *
 * The selector runs on every commit, so it must be cheap and must not allocate
 * a fresh object unless the data really moved — a new array every time would
 * re-render every subscriber on every poll. Pass `isEqual` when the slice is a
 * computed collection.
 */
export function useUiSelector<T>(select: (state: UiState) => T, isEqual?: (a: T, b: T) => boolean): T {
  // `useSyncExternalStore` compares snapshots with `Object.is`, so the custom
  // comparison has to happen INSIDE the snapshot: returning the previous value
  // when the new one is judged equal is what stops the re-render. Comparing
  // after the fact would only stabilise a reference for a render already made.
  const previous = useRef<{ has: boolean; value: T }>({ has: false, value: undefined as T });
  const read = useCallback((): T => {
    const next = select(store.getSnapshot());
    const cache = previous.current;
    if (cache.has && isEqual && (cache.value === next || isEqual(cache.value, next))) return cache.value;
    previous.current = { has: true, value: next };
    return next;
  }, [select, isEqual]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The action object, stable for the whole session. */
export function useActions(): UiActions {
  return actions;
}

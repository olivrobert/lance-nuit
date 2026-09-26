// The dashboard's whole application state, and the only way to change it.
//
// WHY A HAND-WRITTEN STORE RATHER THAN `useReducer` + context
// -----------------------------------------------------------
// Almost everything that writes here is NOT a React event handler: the fifteen
// second poll, the answer of a detail request that may have been overtaken, the
// launch log that loads by itself when a launch failed before its run. With a
// reducer behind a context, each of those would have to be handed a `dispatch`
// through a ref, and the poll would have to live inside a component to reach it.
// An external store inverts that: the asynchronous code owns the writes and
// calls plain functions, and React subscribes through `useSyncExternalStore`,
// which is exactly the hook React ships for an external mutable source. It also
// keeps the race guard honest — the token that decides whether a late answer is
// still wanted is a store variable, not a piece of rendered state.
//
// WHY A FACTORY
// -------------
// This folder knows nothing about React and nothing about `fetch`. `createUiStore`
// takes the API client as an argument and closes over every piece of state, so
// a test builds one store per case, hands it an API whose promises it resolves
// by hand, and drives the two things worth checking here — a detail answer that
// arrives after the reader moved on, and a poll interleaving with a verb —
// without a global to reset and without stubbing `fetch`. The application builds
// exactly one store, in `store.ts`, and that is where the React hooks live.
//
// ONE CONCERN PER MODULE, ONE SNAPSHOT FOR ALL
// --------------------------------------------
//   state.ts          the shape, the tunings, the contract
//   core.ts           the snapshot, `set`, `stage`, the signed `commit`
//   selection.ts      the race guard and the choice of the open item
//   detail-loader.ts  the open sheet's reads
//   refresh.ts        the whole-screen read, serialised
//   toasts.ts         the toast and the clipboard
// This file wires them and holds the actions: what a reader's gesture changes,
// and in which order it repaints.

import type { Item, RequestedSheetTab, VerbAction } from "../api/types.js";
import { createCore } from "./core.js";
import { createDetailLoader } from "./detail-loader.js";
import { createRefresh } from "./refresh.js";
import { createSelection, selectionVisible } from "./selection.js";
import { INITIAL, SEARCH_DEBOUNCE_MS, type UiActions, type UiApi, type UiStore } from "./state.js";
import { createToasts } from "./toasts.js";

export type { UiApi } from "./state.js";

export function createUiStore(api: UiApi): UiStore {
  const core = createCore(INITIAL);
  const selection = createSelection();
  const loader = createDetailLoader(core, api, selection);
  const refresh = createRefresh(core, api, selection, loader);
  const toasts = createToasts(core);

  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Load the open sheet, then repaint whatever it brought. */
  function reloadDetail(): void {
    void loader.loadDetail().then(() => core.commit(true));
  }

  const actions: UiActions = {
    refresh,

    async chooseUser(name: string): Promise<void> {
      const result = await api.chooseUser(name);
      if (!result.ok) {
        toasts.show(`Name rejected: ${result.body.error ?? result.status}`);
        return;
      }
      core.stage({ user: result.body.user ?? null });
      await refresh(true);
    },

    setFilter(name: string | null): void {
      core.stage({ filter: name });
      if (!selectionVisible(core.state)) core.stage(selection.pickFirst(core.state));
      core.commit(true);
      if (!core.state.detail) reloadDetail();
    },

    /**
     * Typing in the search box.
     *
     * The text commits on every keystroke, so nothing a poll does can overwrite
     * what is being typed. Moving the selection to another item is what waits:
     * jumping mid-word is disorienting, and it would throw away a detail request
     * for every character.
     */
    setQuery(text: string): void {
      core.set({ query: text });
      if (searchTimer !== null) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        if (selectionVisible(core.state)) return;
        core.stage(selection.pickFirst(core.state));
        core.commit(true);
        reloadDetail();
      }, SEARCH_DEBOUNCE_MS);
    },

    select(key: string): void {
      if (core.state.selected === key) return;
      core.set({ selected: key, ...selection.cleared() });
      reloadDetail();
    },

    setSheetTab(tab: RequestedSheetTab): void {
      core.set({ sheetTab: tab });
    },

    openFile(path: string): void {
      if (core.state.filePath === path) return;
      core.set({ filePath: path, file: null });
      void loader.loadFile().then(() => core.commit(true));
    },

    toggleDir(path: string, open: boolean): void {
      const current = core.state.openDirs;
      const openDirs = open
        ? current.includes(path)
          ? current
          : [...current, path]
        : current.filter((entry) => entry !== path);
      if (openDirs === current) return;
      core.set({ openDirs });
    },

    setReply(key: string, text: string): void {
      core.set({ replies: { ...core.state.replies, [key]: text } });
    },

    /**
     * Post one verb.
     *
     * The body repeats the pipeline and the run id the sheet was showing, so a
     * click on an item that moved since the last poll is refused by the server
     * instead of applied to a run the reader never saw. `pending` blocks every
     * button while the request is in flight, which is what stops a double click
     * from launching twice.
     */
    async runVerb(item: Item, verb: VerbAction, options: { budget?: number } = {}): Promise<void> {
      if (core.state.pending !== null) return;
      const payload = {
        project: item.project.name,
        ticket: item.ticket,
        pipeline: item.pipeline,
        runId: item.runId,
        ...(verb.verb === "approve-and-rerun" || verb.verb === "approve" ? { subject: item.stop?.subject } : {}),
        ...(typeof options.budget === "number" ? { budget: options.budget } : {}),
      };
      core.set({ pending: verb.verb });
      try {
        const result = await api.postAction(verb.verb, payload);
        if (!result.ok) {
          toasts.show(`Rejected: ${result.body.error ?? result.status}`);
          return;
        }
        toasts.show(`Started: ${verb.label} — the run is starting.`);
      } catch (error) {
        toasts.show(`Launch failed: ${error}`);
      } finally {
        // `set`, not `stage`: a refused verb returns before the refresh below,
        // and the buttons must come back the moment the request is over.
        core.set({ pending: null });
      }
      await refresh(true);
    },

    async addProject(path: string): Promise<void> {
      const result = await api.writeProject("add", path);
      if (!result.ok) {
        toasts.show(`Project rejected: ${result.body.error ?? result.status}`);
        return;
      }
      await refresh(true);
    },

    async removeProject(path: string): Promise<void> {
      const result = await api.writeProject("remove", path);
      if (!result.ok) {
        toasts.show(`Project removal rejected: ${result.body.error ?? result.status}`);
        return;
      }
      await refresh(true);
    },

    async showLaunchLog(id: string): Promise<void> {
      await loader.loadLaunchLog(id);
      core.commit(true);
    },

    hideLaunchLog(): void {
      core.set({ launchLog: null });
    },

    toast: toasts.show,
    copy: toasts.copy,
  };

  return { getSnapshot: () => core.state, subscribe: core.subscribe, actions };
}

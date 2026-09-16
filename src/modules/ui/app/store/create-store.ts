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
// This file knows nothing about React and nothing about `fetch`. `createUiStore`
// takes the API client as an argument and closes over every piece of state, so
// a test builds one store per case, hands it an API whose promises it resolves
// by hand, and drives the two things worth checking here — a detail answer that
// arrives after the reader moved on, and a poll interleaving with a verb —
// without a global to reset and without stubbing `fetch`. The application builds
// exactly one store, in `store.ts`, and that is where the React hooks live.
//
// THREE PIECES OF STATE EARN THEIR PLACE HERE, not in a component
// ---------------------------------------------------------------
//   `replies`   draft answers by item key. A poll must never wipe what is being
//               typed, so the draft cannot live in the textarea that a repaint
//               may unmount.
//   `openDirs`  directories the reader opened in the explorer. They survive a
//               poll and a tab switch, and a directory containing the selected
//               file counts as open without being listed.
//   the token   `detailToken`, below: a selection change invalidates every
//               request in flight, so an answer that arrives late is dropped
//               instead of overwriting the sheet the reader is now looking at.

import type * as client from "../api/client.js";
import type {
  Assumptions,
  FileView,
  Item,
  ItemDetail,
  LaunchLog,
  ProjectEntry,
  Queue,
  RequestedSheetTab,
  VerbAction,
} from "../api/types.js";
import { failedBeforeRun, findAssumptions, isWaiting, splitKey, visibleItems } from "../lib/derive.js";

/** Poll interval of the morning box: the dashboard polls, it opens no SSE stream. */
export const POLL_MS = 15000;

/** Lines of a launch log shown in the sheet. */
export const LOG_LINES = 20;

/** Idle time before a keystroke in the search box re-picks the selected item.
 *  React repaints on every keystroke for free; what is deferred is the jump to
 *  another item, which would otherwise fire mid-word. */
export const SEARCH_DEBOUNCE_MS = 120;

/** How long a toast stays on screen. */
const TOAST_MS = 6000;

/** What the store needs from the server: the client module's call surface, so
 *  the application passes the module itself and a test passes a fake. */
export type UiApi = Pick<
  typeof client,
  | "chooseUser"
  | "fetchFile"
  | "fetchItemDetail"
  | "fetchItems"
  | "fetchLaunchLog"
  | "fetchMe"
  | "fetchProjects"
  | "postAction"
  | "writeProject"
>;

export interface Toast {
  /** Monotonic, so an identical message twice in a row still remounts. */
  id: number;
  message: string;
}

export interface UiState {
  /** `null` until a name is chosen; the identity page is shown instead. */
  user: string | null;
  users: string[];
  projects: ProjectEntry[];
  items: Item[];
  /** Project name the chips filter on, or `null` for every project. */
  filter: string | null;
  query: string;
  queue: Queue;
  /** `<project>/<ticket>` of the open sheet. */
  selected: string | null;
  detail: ItemDetail | null;
  /** Explorer selection, relative to the effective work-item directory. */
  filePath: string | null;
  file: FileView | null;
  assumptions: Assumptions | null;
  /** Directories the reader opened, by relative path. An array rather than a
   *  `Set` so the snapshot stays comparable and serialisable. */
  openDirs: readonly string[];
  /** Draft answers, by item key. */
  replies: Readonly<Record<string, string>>;
  launchLog: LaunchLog | null;
  sheetTab: RequestedSheetTab;
  /** Verb being posted right now, so a double click posts once. */
  pending: string | null;
  toast: Toast | null;
  /** False until the first `refresh` answered: the shell shows nothing rather
   *  than flashing an empty inbox. */
  loaded: boolean;
}

const INITIAL: UiState = {
  user: null,
  users: [],
  projects: [],
  items: [],
  filter: null,
  query: "",
  queue: "attention",
  selected: null,
  detail: null,
  filePath: null,
  file: null,
  assumptions: null,
  openDirs: [],
  replies: {},
  launchLog: null,
  sheetTab: "auto",
  pending: null,
  toast: null,
  loaded: false,
};

export interface UiActions {
  /** Read everything again; `force` repaints even when nothing moved. */
  refresh(force?: boolean): Promise<void>;
  chooseUser(name: string): Promise<void>;
  setFilter(name: string | null): void;
  setQueue(queue: Queue): void;
  setQuery(text: string): void;
  select(key: string): void;
  setSheetTab(tab: RequestedSheetTab): void;
  openFile(path: string): void;
  /** Open or close one explorer directory, by relative path. */
  toggleDir(path: string, open: boolean): void;
  /** Record a draft answer for one item key. */
  setReply(key: string, text: string): void;
  /** Post one verb. `budget` is required by the `budget` verb and is asked for
   *  by the caller, which owns the prompt. */
  runVerb(item: Item, verb: VerbAction, options?: { budget?: number }): Promise<void>;
  addProject(path: string): Promise<void>;
  removeProject(path: string): Promise<void>;
  showLaunchLog(id: string): Promise<void>;
  hideLaunchLog(): void;
  toast(message: string): void;
  copy(value: string): Promise<void>;
}

/** What `useSyncExternalStore` needs, plus the actions. */
export interface UiStore {
  getSnapshot(): UiState;
  subscribe(listener: () => void): () => void;
  /** Created once with the store and never replaced, so a component may put it
   *  in a dependency array without ever re-running the effect. */
  actions: UiActions;
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
  ]);
}

export function createUiStore(api: UiApi): UiStore {
  let state: UiState = INITIAL;
  const listeners = new Set<() => void>();

  /** Race guard. Incremented by every change of selection; an answer whose
   *  token no longer matches is thrown away rather than rendered over the new
   *  sheet. */
  let detailToken = 0;

  /** Signature of the last committed screen, so an idle poll costs no re-render. */
  let signature = "";

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let toastSeq = 0;

  function getSnapshot(): UiState {
    return state;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  /** Change the state and repaint. */
  function set(patch: Partial<UiState>): void {
    state = { ...state, ...patch };
    notify();
  }

  /** Change the state without repainting yet. The poll uses this to assemble a
   *  whole new screen — identity, projects, items, detail, file — and then
   *  decides ONCE whether anything a reader can see actually moved. */
  function stage(patch: Partial<UiState>): void {
    state = { ...state, ...patch };
  }

  /** Commit whatever `stage` accumulated, if it changed anything visible. */
  function commit(force = false): void {
    const next = signatureOf(state);
    if (!force && next === signature) return;
    signature = next;
    notify();
  }

  // ───────────────────────── selection ─────────────────────────

  /** Everything that belongs to the previously open item. Kept in one place so
   *  a selection change can never forget half of it. */
  function clearedDetail(): Partial<UiState> {
    detailToken += 1;
    return {
      sheetTab: "auto",
      detail: null,
      filePath: null,
      file: null,
      assumptions: null,
      launchLog: null,
      openDirs: [],
    };
  }

  /** Keep the reader on the first item that wants them, as the box opens. */
  function pickFirst(next: UiState): Partial<UiState> {
    const rows = visibleItems(next.items, { filter: next.filter, queue: next.queue, query: next.query });
    const first = rows.find(isWaiting) ?? rows[0];
    return { selected: first ? first.key : null, ...clearedDetail() };
  }

  function currentSelectionVisible(): boolean {
    return visibleItems(state.items, { filter: state.filter, queue: state.queue, query: state.query }).some(
      (item) => item.key === state.selected,
    );
  }

  // ───────────────────────── loading ─────────────────────────

  /**
   * Read the detail of the selected item, and everything that hangs off it.
   *
   * The token is captured before the request and checked after: a reader who
   * moved on gets nothing written under them. The file, the assumptions and the
   * launch log are then loaded in parallel, each re-checking the same token.
   */
  async function loadDetail(): Promise<void> {
    if (!state.selected) return;
    const token = detailToken;
    const selected = state.selected;
    const [project, ticket] = splitKey(selected);
    const result = await api.fetchItemDetail(project, ticket);
    if (token !== detailToken || selected !== state.selected) return;
    if (!result.ok || !result.body.item) {
      stage({ detail: null });
      return;
    }
    const detail = result.body as ItemDetail;
    const filePath = state.filePath ?? detail.tree?.gatePath ?? detail.tree?.defaultPath ?? null;
    stage({ detail, filePath });
    await Promise.all([loadFile(token), loadAssumptions(token), loadLaunchLogIfNeeded(detail.item, token)]);
  }

  async function loadFile(token = detailToken): Promise<void> {
    const detail = state.detail;
    const path = state.filePath;
    if (!detail || !path) {
      stage({ file: null });
      return;
    }
    const result = await api.fetchFile(detail.item, path, "html");
    if (token !== detailToken || path !== state.filePath) return;
    stage({
      file: result.ok
        ? (result.body as FileView)
        : { status: "error", error: result.body.error ?? `error ${result.status}` },
    });
  }

  /** The assumptions block reads one known file of the tree, when it is there. */
  async function loadAssumptions(token = detailToken): Promise<void> {
    stage({ assumptions: null });
    const detail = state.detail;
    if (!detail?.tree) return;
    const found = findAssumptions(detail.tree.children);
    if (!found) return;
    const result = await api.fetchFile(detail.item, found.path, "raw");
    if (token !== detailToken) return;
    const body = result.body as { status?: string; content?: string };
    if (!result.ok || body.status !== "ok" || typeof body.content !== "string") return;
    try {
      stage({ assumptions: JSON.parse(body.content) as Assumptions });
    } catch {
      // A hand-edited file that no longer parses simply shows as absent.
      stage({ assumptions: null });
    }
  }

  /** The log of a launch is fetched on its own when the sheet has to show it: a
   *  failure before run opens it; a launch still running keeps what the reader
   *  opened. */
  async function loadLaunchLogIfNeeded(item: Item, token = detailToken): Promise<void> {
    const launch = item.launch;
    if (!launch) {
      stage({ launchLog: null });
      return;
    }
    if (state.launchLog && state.launchLog.id !== launch.id) stage({ launchLog: null });
    if (failedBeforeRun(item) || state.launchLog) await loadLaunchLog(launch.id, token);
  }

  async function loadLaunchLog(id: string, token = detailToken): Promise<void> {
    const result = await api.fetchLaunchLog(id, LOG_LINES);
    if (token !== detailToken) return;
    stage({ launchLog: result.ok ? ({ ...result.body, id } as LaunchLog) : { status: "not-found", id } });
  }

  let inflightRefresh: Promise<void> | null = null;

  /**
   * Read everything again.
   *
   * `force` commits even when nothing moved, which is what an action needs: the
   * reader clicked, so the screen must answer.
   *
   * Refreshes run one at a time. The poll and a verb can both ask for one, and
   * two of them interleaving would `stage` a stale `items` over a fresh
   * `detail`, or the reverse: `detailToken` guards a change of selection, not
   * two reads of the same selection. Queuing the second behind the first keeps
   * every read whole and in order, and the caller still gets a refresh made
   * after its own action.
   */
  function refresh(force = false): Promise<void> {
    const run = (inflightRefresh ?? Promise.resolve()).then(() => performRefresh(force));
    const settled = run.finally(() => {
      if (inflightRefresh === settled) inflightRefresh = null;
    });
    inflightRefresh = settled;
    return settled;
  }

  async function performRefresh(force: boolean): Promise<void> {
    const me = await api.fetchMe();
    stage({
      user: me.body.user ?? null,
      users: Array.isArray(me.body.users) ? me.body.users : [],
      loaded: true,
    });
    if (!state.user) {
      commit(force);
      return;
    }

    const [projects, items] = await Promise.all([api.fetchProjects(), api.fetchItems()]);
    stage({
      projects: projects.ok ? (projects.body.projects ?? []) : [],
      items: items.ok ? (items.body.items ?? []) : [],
    });

    if (state.selected && !state.items.some((item) => item.key === state.selected)) stage(pickFirst(state));
    if (!state.selected) stage(pickFirst(state));
    await loadDetail();
    commit(force);
  }

  // ───────────────────────── actions ─────────────────────────

  function showToast(message: string): void {
    toastSeq += 1;
    if (toastTimer !== null) clearTimeout(toastTimer);
    set({ toast: { id: toastSeq, message } });
    toastTimer = setTimeout(() => {
      toastTimer = null;
      set({ toast: null });
    }, TOAST_MS);
  }

  /** Copy to the clipboard, falling back to showing the value: over a tunnel
   *  the page is plain HTTP, where `navigator.clipboard` may not exist at all,
   *  and a reader who can read the string can still select it. */
  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      showToast("Copied.");
    } catch {
      showToast(value);
    }
  }

  const actions: UiActions = {
    refresh,

    async chooseUser(name: string): Promise<void> {
      const result = await api.chooseUser(name);
      if (!result.ok) {
        showToast(`Name rejected: ${result.body.error ?? result.status}`);
        return;
      }
      stage({ user: result.body.user ?? null });
      await refresh(true);
    },

    setFilter(name: string | null): void {
      stage({ filter: name });
      if (!currentSelectionVisible()) stage(pickFirst(state));
      commit(true);
      if (!state.detail) void loadDetail().then(() => commit(true));
    },

    setQueue(queue: Queue): void {
      stage({ queue });
      stage(pickFirst(state));
      commit(true);
      void loadDetail().then(() => commit(true));
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
      set({ query: text });
      if (searchTimer !== null) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        if (currentSelectionVisible()) return;
        stage(pickFirst(state));
        commit(true);
        void loadDetail().then(() => commit(true));
      }, SEARCH_DEBOUNCE_MS);
    },

    select(key: string): void {
      if (state.selected === key) return;
      set({ selected: key, ...clearedDetail() });
      void loadDetail().then(() => commit(true));
    },

    setSheetTab(tab: RequestedSheetTab): void {
      set({ sheetTab: tab });
    },

    openFile(path: string): void {
      if (state.filePath === path) return;
      set({ filePath: path, file: null });
      void loadFile().then(() => commit(true));
    },

    toggleDir(path: string, open: boolean): void {
      const openDirs = open
        ? state.openDirs.includes(path)
          ? state.openDirs
          : [...state.openDirs, path]
        : state.openDirs.filter((entry) => entry !== path);
      if (openDirs === state.openDirs) return;
      set({ openDirs });
    },

    setReply(key: string, text: string): void {
      set({ replies: { ...state.replies, [key]: text } });
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
      if (state.pending !== null) return;
      const payload = {
        project: item.project.name,
        ticket: item.ticket,
        pipeline: item.pipeline,
        runId: item.runId,
        ...(verb.verb === "approve-and-rerun" || verb.verb === "approve" ? { subject: item.stop?.subject } : {}),
        ...(typeof options.budget === "number" ? { budget: options.budget } : {}),
      };
      set({ pending: verb.verb });
      try {
        const result = await api.postAction(verb.verb, payload);
        if (!result.ok) {
          showToast(`Rejected: ${result.body.error ?? result.status}`);
          return;
        }
        showToast(`Started: ${verb.label} — the run is starting.`);
      } catch (error) {
        showToast(`Launch failed: ${error}`);
      } finally {
        // `set`, not `stage`: a refused verb returns before the refresh below,
        // and the buttons must come back the moment the request is over.
        set({ pending: null });
      }
      await refresh(true);
    },

    async addProject(path: string): Promise<void> {
      const result = await api.writeProject("add", path);
      if (!result.ok) {
        showToast(`Project rejected: ${result.body.error ?? result.status}`);
        return;
      }
      await refresh(true);
    },

    async removeProject(path: string): Promise<void> {
      const result = await api.writeProject("remove", path);
      if (!result.ok) {
        showToast(`Project removal rejected: ${result.body.error ?? result.status}`);
        return;
      }
      await refresh(true);
    },

    async showLaunchLog(id: string): Promise<void> {
      await loadLaunchLog(id);
      commit(true);
    },

    hideLaunchLog(): void {
      set({ launchLog: null });
    },

    toast: showToast,
    copy,
  };

  return { getSnapshot, subscribe, actions };
}

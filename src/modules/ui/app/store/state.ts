// The shape of the dashboard's state, its tunings, and the contract of the store
// built over it. No behaviour lives here: `core.ts` owns the snapshot, the other
// modules of this folder own one concern each, and `create-store.ts` wires them.
//
// THREE PIECES OF STATE EARN THEIR PLACE HERE, not in a component
// ---------------------------------------------------------------
//   `replies`   draft answers by item key. A poll must never wipe what is being
//               typed, so the draft cannot live in the textarea that a repaint
//               may unmount.
//   `openDirs`  directories the reader opened in the explorer. They survive a
//               poll and a tab switch, and a directory containing the selected
//               file counts as open without being listed.
//   the token   `detailToken`, in `selection.ts`: a selection change invalidates
//               every request in flight, so an answer that arrives late is
//               dropped instead of overwriting the sheet the reader now looks at.

import type * as client from "../api/client.js";
import type {
  Assumptions,
  FileView,
  Item,
  ItemDetail,
  LaunchLog,
  ProjectEntry,
  RequestedSheetTab,
  VerbAction,
} from "../api/types.js";

/** Poll interval of the morning box: the dashboard polls, it opens no SSE stream. */
export const POLL_MS = 15000;

/** Poll interval while the tab is hidden: slow enough to cost nothing, fast
 *  enough for its title count and its notifications to stay useful. */
export const HIDDEN_POLL_MS = 60000;

/** Lines of a launch log shown in the sheet. */
export const LOG_LINES = 20;

/** Idle time before a keystroke in the search box re-picks the selected item.
 *  React repaints on every keystroke for free; what is deferred is the jump to
 *  another item, which would otherwise fire mid-word. */
export const SEARCH_DEBOUNCE_MS = 120;

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
  /** When the last refresh read the server whole, in epoch milliseconds. Left
   *  out of the repaint signature: it moves on every poll, and the banner that
   *  shows its age ticks on its own clock. */
  refreshedAt: number | null;
  /** Why the last refresh failed, or `null` once one succeeds again. The screen
   *  keeps what it last read, so the banner is what says it may be stale. */
  refreshError: string | null;
}

export const INITIAL: UiState = {
  user: null,
  users: [],
  projects: [],
  items: [],
  filter: null,
  query: "",
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
  refreshedAt: null,
  refreshError: null,
};

export interface UiActions {
  /** Read everything again; `force` repaints even when nothing moved. A failed
   *  read never rejects: it is recorded in `refreshError`. */
  refresh(force?: boolean): Promise<void>;
  chooseUser(name: string): Promise<void>;
  setFilter(name: string | null): void;
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

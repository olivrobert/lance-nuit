// Reading the open sheet: the item's detail, and everything that hangs off it —
// the explorer file, the assumptions block, the launch log.
//
// Every load stages, never commits: the caller decides when the screen repaints.
// Every load re-checks the selection token after its request, so a reader who
// moved on gets nothing written under them.

import type { Assumptions, FileView, Item, ItemDetail, LaunchLog } from "../api/types.js";
import { failedBeforeRun, splitKey } from "../lib/items.js";
import { findAssumptions } from "../lib/work-item-tree.js";
import type { StoreCore } from "./core.js";
import type { Selection } from "./selection.js";
import { LOG_LINES, type UiApi } from "./state.js";

export interface DetailLoader {
  /** The selected item's detail, then its file, assumptions and launch log. */
  loadDetail(): Promise<void>;
  /** The explorer file at the current `filePath`. */
  loadFile(): Promise<void>;
  /** One launch's log, whether or not the sheet would open it by itself. */
  loadLaunchLog(id: string): Promise<void>;
}

export function createDetailLoader(core: StoreCore, api: UiApi, selection: Selection): DetailLoader {
  /**
   * The token is captured before the request and checked after. The file, the
   * assumptions and the launch log are then loaded in parallel, each
   * re-checking the same token.
   */
  async function loadDetail(): Promise<void> {
    const selected = core.state.selected;
    if (!selected) return;
    const token = selection.token();
    const [project, ticket] = splitKey(selected);
    const result = await api.fetchItemDetail(project, ticket);
    if (!selection.isCurrent(token) || selected !== core.state.selected) return;
    if (!result.ok || !result.body.item) {
      core.stage({ detail: null });
      return;
    }
    const detail = result.body as ItemDetail;
    const filePath = core.state.filePath ?? detail.tree?.gatePath ?? detail.tree?.defaultPath ?? null;
    core.stage({ detail, filePath });
    await Promise.all([loadFile(token), loadAssumptions(token), loadLaunchLogIfNeeded(detail.item, token)]);
  }

  async function loadFile(token = selection.token()): Promise<void> {
    const { detail, filePath: path } = core.state;
    if (!detail || !path) {
      core.stage({ file: null });
      return;
    }
    const result = await api.fetchFile(detail.item, path, "html");
    if (!selection.isCurrent(token) || path !== core.state.filePath) return;
    core.stage({
      file: result.ok
        ? (result.body as FileView)
        : { status: "error", error: result.body.error ?? `error ${result.status}` },
    });
  }

  /** The assumptions block reads one known file of the tree, when it is there. */
  async function loadAssumptions(token: number): Promise<void> {
    core.stage({ assumptions: null });
    const detail = core.state.detail;
    if (!detail?.tree) return;
    const found = findAssumptions(detail.tree.children);
    if (!found) return;
    const result = await api.fetchFile(detail.item, found.path, "raw");
    if (!selection.isCurrent(token)) return;
    const body = result.body as { status?: string; content?: string };
    if (!result.ok || body.status !== "ok" || typeof body.content !== "string") return;
    try {
      core.stage({ assumptions: JSON.parse(body.content) as Assumptions });
    } catch {
      // A hand-edited file that no longer parses simply shows as absent.
      core.stage({ assumptions: null });
    }
  }

  /** The log of a launch is fetched on its own when the sheet has to show it: a
   *  failure before run opens it; a launch still running keeps what the reader
   *  opened. */
  async function loadLaunchLogIfNeeded(item: Item, token: number): Promise<void> {
    const launch = item.launch;
    if (!launch) {
      core.stage({ launchLog: null });
      return;
    }
    if (core.state.launchLog && core.state.launchLog.id !== launch.id) core.stage({ launchLog: null });
    if (failedBeforeRun(item) || core.state.launchLog) await loadLaunchLog(launch.id, token);
  }

  async function loadLaunchLog(id: string, token = selection.token()): Promise<void> {
    const result = await api.fetchLaunchLog(id, LOG_LINES);
    if (!selection.isCurrent(token)) return;
    core.stage({ launchLog: result.ok ? ({ ...result.body, id } as LaunchLog) : { status: "not-found", id } });
  }

  return {
    loadDetail,
    loadFile: () => loadFile(),
    loadLaunchLog: (id) => loadLaunchLog(id),
  };
}

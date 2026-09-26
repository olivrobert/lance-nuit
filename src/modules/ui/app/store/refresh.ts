// Reading the whole screen again: identity, projects, items, then the sheet.
//
// Refreshes run one at a time. The poll and a verb can both ask for one, and two
// of them interleaving would `stage` a stale `items` over a fresh `detail`, or
// the reverse: the selection token guards a change of selection, not two reads
// of the same selection. Queuing the second behind the first keeps every read
// whole and in order, and the caller still gets a refresh made after its own
// action.

import type { StoreCore } from "./core.js";
import type { DetailLoader } from "./detail-loader.js";
import type { Selection } from "./selection.js";
import type { UiApi } from "./state.js";

/** Read everything again; `force` commits even when nothing moved, which is
 *  what an action needs: the reader clicked, so the screen must answer. */
export type Refresh = (force?: boolean) => Promise<void>;

export function createRefresh(core: StoreCore, api: UiApi, selection: Selection, loader: DetailLoader): Refresh {
  let inflight: Promise<void> | null = null;

  /**
   * One refresh, with its outcome recorded rather than thrown.
   *
   * A server that stopped answering is a state of the screen, not an incident of
   * one poll: the banner keeps saying so until a read succeeds again, instead of
   * a toast repeated every fifteen seconds and gone in between.
   */
  async function guarded(force: boolean): Promise<void> {
    try {
      await perform(force);
    } catch (error) {
      core.stage({ refreshError: error instanceof Error ? error.message : String(error) });
      core.commit(force);
    }
  }

  async function perform(force: boolean): Promise<void> {
    const me = await api.fetchMe();
    core.stage({
      user: me.body.user ?? null,
      users: Array.isArray(me.body.users) ? me.body.users : [],
      loaded: true,
    });
    if (!core.state.user) {
      core.stage({ refreshedAt: Date.now(), refreshError: null });
      core.commit(force);
      return;
    }

    const [projects, items] = await Promise.all([api.fetchProjects(), api.fetchItems()]);
    // A refused read keeps the previous list on screen: an inbox that empties
    // itself on one server error reads as "nothing to review", which is the
    // one wrong answer this page must never give.
    if (!projects.ok || !items.ok) {
      const failed = projects.ok ? items : projects;
      core.stage({ refreshError: failed.body.error ?? `error ${failed.status}` });
      core.commit(force);
      return;
    }
    core.stage({
      projects: projects.body.projects ?? [],
      items: items.body.items ?? [],
      refreshedAt: Date.now(),
      refreshError: null,
    });

    const { selected } = core.state;
    if (!selected || !core.state.items.some((item) => item.key === selected)) {
      core.stage(selection.pickFirst(core.state));
    }
    await loader.loadDetail();
    core.commit(force);
  }

  return (force = false) => {
    const run = (inflight ?? Promise.resolve()).then(() => guarded(force));
    const settled = run.finally(() => {
      if (inflight === settled) inflight = null;
    });
    inflight = settled;
    return settled;
  };
}

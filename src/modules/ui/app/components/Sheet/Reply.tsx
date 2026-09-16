// The reply zone.
//
// The reply itself is not sent from here (spec H5): the `comment` port has no
// CLI verb yet, and the dashboard only ever runs commands that already exist. So
// the zone shows the answer and the command to copy: post the answer on the
// tracker, then resume the run.
//
// The draft is held by the store rather than by the textarea, because the
// fifteen second poll must never be able to wipe what is being typed.

import type { JSX } from "react";
import { useCallback } from "react";
import type { Item } from "../../api/types.js";
import type { UiState } from "../../store/store.js";
import { actions, useUiSelector } from "../../store/store.js";

export function Reply({ item }: { item: Item }): JSX.Element {
  const draft = useUiSelector(useCallback((state: UiState): string => state.replies[item.key] ?? "", [item.key]));
  const command = `cd ${item.project.cwd} && lancenuit run ${item.ticket} --pipeline ${item.pipeline}${item.worktree ? " --worktree" : ""}`;

  return (
    <div>
      <textarea
        placeholder="Your ticket reply (it will be included in the next ticket.md)…"
        value={draft}
        onChange={(event) => actions.setReply(item.key, event.target.value)}
      />
      <p className="small mute">
        {`In v1, post the reply on the ticket (${item.project.provider}); the pipeline will read it on the next run.`}
      </p>
      <div className="row">
        <button type="button" onClick={() => void actions.copy(draft)}>
          Copy reply
        </button>
        <button type="button" onClick={() => void actions.copy(command)}>
          Copy rerun command
        </button>
      </div>
      <pre>{command}</pre>
    </div>
  );
}

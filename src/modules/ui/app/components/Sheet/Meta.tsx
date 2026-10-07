// Where the run ran, as a definition list.
//
// Only what the sheet's header does not already show: the project directory and
// its provider, the full run id a command needs, and the branch. It sits inside
// the collapsed panel because a reader needs it when something is surprising and
// never when it is not.

import type { JSX } from "react";
import type { Item } from "../../api/types.js";
import styles from "./Sheet.module.css";

export function Meta({ item }: { item: Item }): JSX.Element {
  return (
    <dl className={styles.kv}>
      <dt>Directory</dt>
      <dd>
        <span>
          <code>{item.project.cwd}</code>
          <span className="mute">{` · ${item.project.provider}`}</span>
        </span>
      </dd>

      <dt>Run</dt>
      <dd>
        <span>
          <code>{item.runId}</code>
          {item.worktree ? <span className="mute"> · worktree</span> : null}
        </span>
      </dd>

      {item.branch ? (
        <>
          <dt>Branch</dt>
          <dd>
            <code>{item.branch}</code>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

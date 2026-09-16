// The latest launch of the open item: who clicked what, and how it ended.
//
// A launch is the dashboard's own record (spec 5.2) and is deliberately shown
// next to — never merged into — the run's status: a launch that failed says
// nothing about the run, and a run that failed says nothing about the launch.
// The exact `argv` is printed because it is the command a reader would type to
// reproduce what the server did.
//
// The log is fetched on demand and lives in the store, so the same tail is shown
// whether it was opened from the diagnostic tab or from the "Last launch" block.

import type { JSX } from "react";
import type { Item } from "../../api/types.js";
import { verbLabel } from "../../lib/derive.js";
import { fmtDate } from "../../lib/format.js";
import type { UiState } from "../../store/store.js";
import { actions, LOG_LINES, useUiSelector } from "../../store/store.js";
import styles from "./Sheet.module.css";

const selectLaunchLog = (state: UiState): UiState["launchLog"] => state.launchLog;

/** How the launcher's process ended, in the vocabulary of the status pills. */
function Outcome({ launch }: { launch: NonNullable<Item["launch"]> }): JSX.Element {
  if (launch.alive) return <span className="tag RUNNING">running</span>;
  if (launch.exitCode === 0) return <span className="tag PASS">completed</span>;
  if (launch.exitCode === null || launch.exitCode === undefined) return <span className="tag ABORTED">aborted</span>;
  return <span className="tag FAIL">{`code ${launch.exitCode}`}</span>;
}

function LaunchLogView(): JSX.Element {
  const log = useUiSelector(selectLaunchLog);
  if (log?.status !== "ok") return <p className="mute small">No log for this launch.</p>;
  return (
    <div>
      <pre className={styles.log}>{log.lines.length ? log.lines.join("\n") : "(empty)"}</pre>
      <div className="row small mute">
        {log.truncated ? `${LOG_LINES} last lines · ` : ""}
        <code>{log.path}</code>
        <button type="button" className="small" onClick={() => void actions.copy(log.path)}>
          copy path
        </button>
      </div>
    </div>
  );
}

export function Launch({ item }: { item: Item }): JSX.Element | null {
  const log = useUiSelector(selectLaunchLog);
  const launch = item.launch;
  if (!launch) return null;

  const toggle = (): void => {
    if (log) actions.hideLaunchLog();
    else void actions.showLaunchLog(launch.id);
  };

  return (
    <div>
      <div className="small">
        <Outcome launch={launch} />
        {` ${verbLabel(launch.verb)} by `}
        <b>{launch.by}</b>
        <span className="mute">{` · ${fmtDate(launch.at)} · pid ${launch.pid}`}</span>
        {" · "}
        <button type="button" className="small" onClick={toggle}>
          {log ? "hide log" : "show log"}
        </button>
      </div>
      <pre>{`lancenuit ${launch.argv.join(" ")}`}</pre>
      {log ? <LaunchLogView /> : null}
    </div>
  );
}

// The banner that says why the item is on screen.
//
// There are five of them and they are mutually exclusive by construction: a live
// launch wins over everything (the run is moving, nothing else matters yet), a
// decision and a technical failure are two groups of the same read model, an
// accounting stop is a failure-group run that no rerun repairs, and a
// launch that died before its run ever moved is a fifth situation that belongs
// to the launcher rather than to the run — it gets its own box, with the end of
// the log in it, because the reason is nowhere else (spec 5.2).

import type { JSX } from "react";
import type { Item } from "../../api/types.js";
import { failedBeforeRun, reasonOf, unmeteredResumeCommand, verbLabel } from "../../lib/derive.js";
import { fmtAge, fmtDate } from "../../lib/format.js";
import type { UiState } from "../../store/store.js";
import { useUiSelector } from "../../store/store.js";
import { Actions } from "./Actions.js";
import styles from "./Callout.module.css";
import sheet from "./Sheet.module.css";

const selectLaunchLog = (state: UiState): UiState["launchLog"] => state.launchLog;

function RunningCallout({ item }: { item: Item }): JSX.Element | null {
  const launch = item.launch;
  if (!launch?.alive) return null;
  return (
    <div className={`${styles.callout} ${styles.run}`}>
      <h3>{`▶ Running — ${verbLabel(launch.verb)}`}</h3>
      <p>
        <b>{`par ${launch.by}`}</b>
        <span className="mute">{` · ${fmtAge(launch.at)} · pid ${launch.pid}`}</span>
      </p>
      <p>The runner is active. This view updates every 15 seconds.</p>
    </div>
  );
}

export interface CalloutProps {
  item: Item;
  /** The diagnostic tab already carries the action row in its header. */
  includeActions?: boolean;
}

export function Callout({ item, includeActions = true }: CalloutProps): JSX.Element | null {
  if (item.launch?.alive) return <RunningCallout item={item} />;
  if (item.group !== "decision" && item.group !== "failure") return null;

  const stopped = item.group === "decision";
  // An accounting stop is not a technical failure: no log holds the reason and no
  // rerun repairs it. It gets its own headline and the one command that lifts it.
  //
  // `item.costUnaccounted` is the read model's answer to "did this run actually
  // stop for accounting" — capped, unauthorized, and with work left. That is why
  // this banner can offer `--allow-unmetered` without checking anything else: an
  // uncapped or already-authorized run never carries the flag, and a `≥` total
  // alone (`item.cost.unknown`) never triggers it.
  const unaccounted = !stopped && item.costUnaccounted === true;
  const subject = item.stop?.subject;
  const heading = stopped
    ? `⏸ Waiting for your decision${subject ? ` — ${subject}` : ""}`
    : unaccounted
      ? "⚠ Spending unaccounted — action needed"
      : "✗ Technical failure — action needed";
  const explanation = stopped
    ? subject
      ? "Review the gate artifact below, then approve to resume the run."
      : "The run is stopped without an approval subject: address the cause, then rerun."
    : unaccounted
      ? "An attempt spent tokens no pricing table could price, so the cost ceiling can no longer be enforced. Pending steps are left resumable. Raising the budget does not help; authorize the unknown spend from the terminal:"
      : "The run failed on a technical step. Rerunning resumes from the failed step; existing approvals remain valid.";

  return (
    <div className={`${styles.callout} ${stopped || unaccounted ? styles.stop : styles.fail}`}>
      <h3>{heading}</h3>
      <p>
        <b>{reasonOf(item)}</b>
        <span className="mute">{` · waiting for ${fmtAge(item.updatedAt)}`}</span>
      </p>
      <p>{explanation}</p>
      {unaccounted ? <pre className={sheet.log}>{unmeteredResumeCommand(item)}</pre> : null}
      {unaccounted ? (
        <p className="mute small">
          It authorizes the unknown spend only: what the run could price still obeys the ceiling.
        </p>
      ) : null}
      {includeActions ? <Actions item={item} /> : null}
    </div>
  );
}

/** A launch that ended before the run moved: lock held, `bun` missing, refusal
 *  of the runner. The store loads the log by itself for this case, so the box
 *  only has to say "loading" until it lands. */
export function LaunchFailureCallout({ item }: { item: Item }): JSX.Element | null {
  const stored = useUiSelector(selectLaunchLog);
  const launch = item.launch;
  if (!launch || !failedBeforeRun(item)) return null;
  const log = stored?.status === "ok" ? stored : null;
  const ending = launch.exitCode === null || launch.exitCode === undefined ? "aborted" : `code ${launch.exitCode}`;

  return (
    <div className={`${styles.callout} ${styles.fail}`}>
      <h3>✗ Launch failed before the run</h3>
      <p>
        <b>{`${verbLabel(launch.verb)} by ${launch.by}`}</b>
        <span className="mute">{` · ${fmtDate(launch.at)} · ${ending}`}</span>
      </p>
      <p>The runner refused or failed to start. Here is the end of its log:</p>
      {log ? (
        <pre className={sheet.log}>{log.lines.length ? log.lines.join("\n") : "(empty log)"}</pre>
      ) : (
        <p className="mute small">Loading log…</p>
      )}
    </div>
  );
}

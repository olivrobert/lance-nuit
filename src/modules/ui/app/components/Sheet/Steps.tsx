// The steps of a run.
//
// Two shapes of the same data, chosen by `compact`: the diagnostic tab wants the
// strip of bars and the counts, the Steps tab wants the numbered list above
// them. Everything below is read from `RunStepsView` alone — no step is ever
// inferred from the item's status, because a snapshot and a journal can
// disagree, and the journal is the one that wrote these steps.

import type { JSX } from "react";
import type { RunStepsView } from "../../api/types.js";
import { fmtDate } from "../../lib/format.js";
import styles from "./Steps.module.css";

export interface StepsProps {
  steps: RunStepsView | null;
  /** Hide the numbered list, keeping the strip and the counts. */
  compact?: boolean;
}

export function Steps({ steps, compact = false }: StepsProps): JSX.Element {
  if (!steps) return <p className="mute small">No readable steps for this run.</p>;

  const done = steps.steps.filter((step) => step.status === "done").length;
  const skipped = steps.steps.filter((step) => step.status === "skipped").length;
  const broken = steps.steps.find((step) => step.status === "failed" || step.status === "aborted");

  return (
    <div>
      {compact ? null : (
        <ol className={styles.stepList}>
          {steps.steps.map((step) => (
            <li key={step.id} className={styles[step.status]}>
              <code>{step.id}</code>
              <span className={styles.stepStatus}>{step.status}</span>
            </li>
          ))}
        </ol>
      )}
      <div className={styles.steps} title={`${steps.steps.length} steps`}>
        {steps.steps.map((step) => (
          <span key={step.id} className={styles[step.status]} title={`${step.id} : ${step.status}`} />
        ))}
      </div>
      <div className="small mute" style={{ marginTop: 4 }}>
        {`${done}/${steps.steps.length} steps complete · ${skipped} skipped`}
        {broken ? <b style={{ color: "var(--fail)" }}>{` · ${broken.id} failed`}</b> : null}
      </div>
      {broken?.error ? <pre>{broken.error}</pre> : null}
      {steps.lastEvent ? (
        <div className="small mute">
          {`Last event: ${steps.lastEvent.type}${steps.lastEvent.stepId ? ` (${steps.lastEvent.stepId})` : ""} · ${fmtDate(steps.lastEvent.at)}`}
        </div>
      ) : null}
    </div>
  );
}

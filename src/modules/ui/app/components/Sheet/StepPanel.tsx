// One step opened from the Run tab's timeline: its attempts, what the chosen
// attempt was given and what it printed, and the files it left behind.
//
// The panel reads `StepDetail` on its own query, mounted only while the step is
// open: the read parses the run journal, which the sheet's poll does not pay
// for. Which attempt is shown lives in the UI store with the open step, so a
// poll repaint never sends the reader back to the last attempt.

import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { stepDetailQuery } from "../../api/queries.js";
import type { Item, StepAttemptView, StepDetail, TextExcerpt } from "../../api/types.js";
import { fmtCost, fmtDuration } from "../../lib/format.js";
import { setOpenStep } from "../../store/ui-store.js";
import { useSheetNavigation } from "./sheet-context.js";
import styles from "./StepPanel.module.css";

function attemptCost(attempt: StepAttemptView): string {
  if (typeof attempt.costUsd !== "number" && !attempt.costUnknown) return "—";
  return fmtCost({
    ...(typeof attempt.costUsd === "number" ? { usd: attempt.costUsd } : {}),
    estimated: attempt.costEstimated === true,
    ...(attempt.costUnknown ? { unknown: true } : {}),
  });
}

/** First line of a reason, for the table; the whole text is printed below it
 *  for the attempt on screen. */
function firstLine(text: string | undefined): string {
  return text ? (text.split("\n").find((line) => line.trim() !== "") ?? "").trim() : "";
}

function FileLink({ path, label }: { path: string; label?: string }): JSX.Element {
  const { openFile } = useSheetNavigation();
  return (
    <button type="button" className={styles.link} onClick={() => openFile(path, "files")}>
      {label ?? path}
    </button>
  );
}

function Attempts({ item, detail }: { item: Item; detail: StepDetail }): JSX.Element {
  return (
    <table className={styles.attempts}>
      <thead>
        <tr>
          <th>#</th>
          <th>Kind</th>
          <th>Status</th>
          <th className={styles.num}>Duration</th>
          <th className={styles.num}>Cost</th>
          <th>Model</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {detail.attempts.map((attempt) => (
          <tr key={attempt.attempt} className={attempt.attempt === detail.attempt ? styles.selected : ""}>
            <td>
              <button
                type="button"
                className={styles.link}
                title="Show this attempt's output and prompt"
                onClick={() => setOpenStep(item.key, { stepId: detail.stepId, attempt: attempt.attempt })}
              >
                {String(attempt.attempt)}
              </button>
            </td>
            <td>{attempt.kind === "fix" ? "fix pass" : "run"}</td>
            <td className={styles[attempt.status]}>{attempt.status}</td>
            <td className={styles.num}>{fmtDuration(attempt.durationMs)}</td>
            <td className={styles.num}>{attemptCost(attempt)}</td>
            <td>{attempt.model ? <code>{attempt.model}</code> : "—"}</td>
            <td className={styles.reason} title={attempt.reason ?? ""}>
              {firstLine(attempt.reason)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Excerpt({
  title,
  excerpt,
  from,
}: {
  title: string;
  excerpt: TextExcerpt;
  from: "head" | "tail";
}): JSX.Element {
  return (
    <>
      <div className={styles.excerptHead}>
        <span>{title}</span>
        <FileLink path={excerpt.path} label={excerpt.truncated ? "Open the whole file" : "Open in Files"} />
      </div>
      <pre
        className={styles.excerpt}
      >{`${from === "tail" && excerpt.truncated ? "…\n" : ""}${excerpt.text}${from === "head" && excerpt.truncated ? "\n…" : ""}`}</pre>
    </>
  );
}

function Body({ item, detail }: { item: Item; detail: StepDetail }): JSX.Element {
  if (detail.attempts.length === 0) return <p className="mute small">This step never started an attempt.</p>;
  const selected = detail.attempts.find((attempt) => attempt.attempt === detail.attempt);
  return (
    <>
      <Attempts item={item} detail={detail} />
      {selected?.reason ? (
        <section>
          <h4
            className={styles.heading}
          >{`Why attempt ${selected.attempt} ${selected.status === "aborted" ? "was aborted" : "failed"}`}</h4>
          <pre className={styles.excerpt}>{selected.reason}</pre>
        </section>
      ) : null}
      <section>
        {detail.output ? (
          <Excerpt title={`Output of attempt ${detail.attempt ?? ""}`} excerpt={detail.output} from="tail" />
        ) : (
          <p className="mute small">No output was kept for this attempt.</p>
        )}
      </section>
      <section>
        {detail.command ? (
          <details>
            <summary>{selected?.model || selected?.kind === "fix" ? "Prompt" : "Command"}</summary>
            <Excerpt title="As the runner rendered it" excerpt={detail.command} from="head" />
          </details>
        ) : (
          <p className="mute small">The prompt of this attempt was not kept: it ran before the runner saved it.</p>
        )}
      </section>
      <section className={styles.files}>
        <h4 className={styles.heading}>Files</h4>
        {detail.produced.length > 0 ? (
          <ul>
            {detail.produced.map((path) => (
              <li key={path}>
                <FileLink path={path} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mute small">No artifact is recorded as produced by this step.</p>
        )}
      </section>
    </>
  );
}

export interface StepPanelProps {
  item: Item;
  stepId: string;
  attempt?: number;
}

export function StepPanel({ item, stepId, attempt }: StepPanelProps): JSX.Element {
  const query = useQuery(stepDetailQuery(item, stepId, attempt));
  return (
    <div className={styles.panel}>
      {query.data ? (
        <Body item={item} detail={query.data} />
      ) : query.error ? (
        <p className="mute small">{`Could not read ${stepId}: ${query.error.message}`}</p>
      ) : (
        <p className="mute small">Loading…</p>
      )}
    </div>
  );
}

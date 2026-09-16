// `artifacts/assumptions.json` as the pipelines write it: the assumptions that
// block, the documents that are still missing, and the ones the code later
// settled by itself.
//
// Nothing validates that file, so every field is read defensively and every
// value is coerced to a string before it reaches the page. The resolved ones are
// folded away: they are evidence, not a question.

import type { JSX } from "react";
import type { Assumptions as AssumptionsData } from "../../api/types.js";
import type { UiState } from "../../store/store.js";
import { useUiSelector } from "../../store/store.js";
import styles from "./Sheet.module.css";

const selectAssumptions = (state: UiState): AssumptionsData | null => state.assumptions;

export function Assumptions(): JSX.Element {
  const data = useUiSelector(selectAssumptions);
  if (!data) return <p className="mute small">No assumptions.json.</p>;

  const blocking = Array.isArray(data.blocking) ? data.blocking : [];
  const requiredInputs = Array.isArray(data.requiredInputs) ? data.requiredInputs : [];
  const resolved = Array.isArray(data.resolved) ? data.resolved : [];

  return (
    <div>
      {blocking.length > 0 ? (
        blocking.map((entry, index) => (
          <div key={`${entry.ac ?? ""}|${entry.subject ?? index}`} className={styles.hyp}>
            <div className={styles.s}>
              {`${index + 1}. `}
              {entry.ac ? <span className="mute">{`${entry.ac} — `}</span> : null}
              {String(entry.subject ?? "")}
            </div>
            <div className={styles.a}>
              <span className="mute">assumed: </span>
              {String(entry.assumed ?? "")}
            </div>
          </div>
        ))
      ) : (
        <p className="mute small">No blocking assumptions.</p>
      )}

      {requiredInputs.length > 0 ? (
        <>
          <h4 style={{ margin: "10px 0 4px" }}>Required documents</h4>
          <ul className="small">
            {requiredInputs.map((input) => (
              <li key={String(input.path ?? input.why ?? "")}>
                <code>{String(input.path ?? "")}</code>
                {` — ${input.why ?? ""}`}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {resolved.length > 0 ? (
        <details>
          <summary className="small">{`${resolved.length} assumption(s) resolved by code`}</summary>
          {resolved.map((entry) => (
            <div key={String(entry.subject ?? entry.answer ?? "")} className={`${styles.hyp} ${styles.resolved} small`}>
              <div className={styles.s}>{String(entry.subject ?? "")}</div>
              <div className={styles.a}>{String(entry.answer ?? "")}</div>
              {entry.evidence ? <div className="mute">{String(entry.evidence)}</div> : null}
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

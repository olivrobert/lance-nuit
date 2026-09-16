// One approval line and no more: the gates are sequential, so a stopped run has
// exactly one pending subject (spec 4.4).
//
// The three states are worth distinguishing precisely. `absent` means nobody
// decided; `fresh` means the decision still matches the artifact it was taken
// on; `stale` means the artifact moved underneath it, and the gate will reopen —
// which is the only one of the three a reader has to act on.

import type { JSX } from "react";
import type { ApprovalState, Item } from "../../api/types.js";
import { fmtDate } from "../../lib/format.js";

const LABELS: Record<ApprovalState, string> = { absent: "absent", fresh: "current", stale: "stale" };

export function Approval({ item }: { item: Item }): JSX.Element {
  const approval = item.approval;
  if (!approval) return <p className="small mute">No approval is expected for this run.</p>;

  return (
    <div className="small">
      <span className={`tag ${approval.state}`}>{LABELS[approval.state] ?? approval.state}</span>{" "}
      <b>{approval.subject}</b>
      {approval.state === "absent" ? (
        <span className="mute"> — no decision has been recorded for this subject.</span>
      ) : (
        <>
          {` — decided by ${approval.decidedBy ?? "?"} on ${fmtDate(approval.decidedAt)}`}
          {approval.state === "stale" ? (
            <span style={{ color: "var(--stale)" }}> — the artifact changed; the gate will reopen.</span>
          ) : null}
        </>
      )}
    </div>
  );
}

// What a stopped run asks, above whichever tab is open.
//
// A decision is the reason the item is in the inbox, so it is not a tab and not
// a line in the collapsed panel: the question, the state of its approval and the
// two ways to answer — approve from the header, or reply on the ticket — stay on
// screen while the reader moves between the document, the steps and the files
// that inform the answer. Each of them used to live somewhere else (the callout
// in the diagnostic tab, the approval twice, the reply folded away), and a
// reader had to know where to look.
//
// A run of ours still alive on the item is not waiting for anyone: the diagnostic
// tab shows it running, and this panel is not drawn.

import type { JSX } from "react";
import type { Item } from "../../api/types.js";
import { Approval } from "./Approval.js";
import { Callout } from "./Callout.js";
import { Reply } from "./Reply.js";
import styles from "./Sheet.module.css";

/** Whether the sheet shows the decision panel for this item. */
export function showsDecision(item: Item): boolean {
  return item.group === "decision" && item.launch?.alive !== true;
}

export function Decision({ item }: { item: Item }): JSX.Element {
  // "absent" only repeats what the callout says — nobody decided yet — so the
  // approval line is shown when there is a decision to qualify.
  const decided = item.approval && item.approval.state !== "absent";
  return (
    <section className={styles.decision}>
      <Callout item={item} includeActions={false} />
      {decided ? <Approval item={item} /> : null}
      <details className={styles.replyPanel}>
        <summary>Answer on the ticket instead</summary>
        <Reply item={item} />
      </details>
    </section>
  );
}

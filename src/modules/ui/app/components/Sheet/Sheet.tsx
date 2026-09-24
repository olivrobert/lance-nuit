// The sheet: everything the dashboard knows about the item the reader selected.
//
// It is laid out in two parts, and the split matters. The sticky header answers
// "what is this and what can I do about it" — identity, headline, actions, tabs
// — and never scrolls away. Below it, exactly one tab is on screen at a time,
// followed by a collapsed panel holding what is true of the run but is not the
// question being asked: its metadata, its launch, its approval, its assumptions,
// the reply being drafted.
//
// The `<details>` panel is deliberately rendered at a FIXED position in the tree,
// as a sibling of the tab section rather than inside a branch of it. The DOM
// version had to remember whether it was open and reapply that after every
// repaint; here the element simply survives, because React reconciles it in
// place as long as neither its type nor its position changes. Which is why every
// optional block inside it is written `cond ? <X /> : null` and never spliced
// out of an array: a conditional that removes an entry shifts everything after
// it, and a `<details>` that moves is a `<details>` that closes.
//
// One consequence is a deliberate divergence from the DOM version: the panel now
// stays open across a tab switch, where the old renderer closed it. Nothing in
// it — the metadata, the launch, the approval, the assumptions, the draft reply —
// belongs to a tab, so closing it was an artifact of a renderer that rebuilt the
// subtree, not a decision. A reader who opened it keeps it open.

import type { JSX } from "react";
import { currentSheetTab, hasAssumptionContent, headlineOf, visibleItems } from "../../lib/derive.js";
import { fmtAge, fmtCost } from "../../lib/format.js";
import { useUiState } from "../../store/store.js";
import { DocumentView, Folder } from "../Explorer/index.js";
import { ProjectBadge } from "../ProjectBadge.js";
import { StatusTag } from "../StatusTag.js";
import { Actions } from "./Actions.js";
import { Approval } from "./Approval.js";
import { Assumptions } from "./Assumptions.js";
import { Callout, LaunchFailureCallout } from "./Callout.js";
import { Launch } from "./Launch.js";
import { Meta } from "./Meta.js";
import { Reply } from "./Reply.js";
import styles from "./Sheet.module.css";
import { SheetTabs } from "./SheetTabs.js";
import { Steps } from "./Steps.js";
import { TerminalLink } from "./TerminalLink.js";

/** The one tab on screen. The header owns the action row, so the diagnostic
 *  callout is asked not to draw a second one. */
function TabContent(): JSX.Element | null {
  const { detail, sheetTab } = useUiState();
  if (!detail) return null;
  const { item, steps } = detail;
  const tab = currentSheetTab(item, detail, sheetTab);

  if (tab === "steps") {
    return (
      <section className={styles.primaryContent}>
        <h3>Run steps</h3>
        <Steps steps={steps} />
      </section>
    );
  }
  if (tab === "files") {
    return (
      <section className={styles.primaryContent}>
        <h3>Run files</h3>
        <Folder />
      </section>
    );
  }
  if (tab === "document") {
    return (
      <section className={styles.primaryContent}>
        {item.group === "decision" && item.approval ? <Approval item={item} /> : null}
        <DocumentView />
      </section>
    );
  }

  // The error text is printed only when no step carried it already: the runner
  // writes the same reason in both places, and showing it twice reads as two
  // different failures.
  const stepCarriesError = steps?.steps.some(
    (step) => (step.status === "failed" || step.status === "aborted") && step.error,
  );

  return (
    <section className={styles.primaryContent}>
      <h3>{item.failure?.phase ?? (item.group === "failure" ? "Failure details" : "Launch")}</h3>
      <LaunchFailureCallout item={item} />
      {item.group === "failure" ? (
        <p className="mute">
          Resume from this step once the cause is resolved. Completed work and existing approvals are kept.
        </p>
      ) : (
        <Callout item={item} includeActions={false} />
      )}
      {item.group !== "decision" ? <Steps steps={steps} compact /> : null}
      {item.failure?.reason && !stepCarriesError ? <pre>{item.failure.reason}</pre> : null}
      {item.launch ? <Launch item={item} /> : null}
    </section>
  );
}

export function Sheet(): JSX.Element {
  const state = useUiState();
  const detail = state.detail;

  if (!detail) {
    const rows = visibleItems(state.items, { filter: state.filter, queue: state.queue, query: state.query });
    return (
      <main className={styles.sheet}>
        <p className="mute" style={{ padding: 40 }}>
          {rows.length ? "Choose an item." : "Nothing to review."}
        </p>
      </main>
    );
  }

  const { item, tree } = detail;
  const folderLabel = tree ? `work-items/${item.ticket}/` : "";
  const approvalRelevant = item.group === "decision" || (item.approval && item.approval.state !== "absent");
  const replyRelevant = item.group === "decision";
  const tab = currentSheetTab(item, detail, state.sheetTab);

  return (
    <main className={styles.sheet}>
      <div className={styles.top}>
        <div className="row">
          <ProjectBadge name={item.project.name} />
          <StatusTag item={item} />
          <span className="grow" />
          <TerminalLink item={item} />
        </div>
        <p className={styles.breadcrumb}>{`${item.ticket} · ${item.pipeline}`}</p>
        <h2>{headlineOf(item)}</h2>
        <p className={styles.sheetSubtitle}>{`${fmtAge(item.updatedAt)} · ${fmtCost(item.cost)}`}</p>
        <Actions item={item} className={styles.topActions} />
        <SheetTabs item={item} detail={detail} current={tab} />
      </div>
      <div className={styles.body}>
        <TabContent />
        <details className={styles.detailsPanel}>
          <summary>Run details</summary>
          <Meta item={item} />
          {item.launch ? (
            <section className={styles.block}>
              <h3>Last launch</h3>
              <Launch item={item} />
            </section>
          ) : null}
          {approvalRelevant ? (
            <section className={styles.block}>
              <h3>Approval</h3>
              <Approval item={item} />
            </section>
          ) : null}
          {hasAssumptionContent(state.assumptions) ? (
            <section className={styles.block}>
              <h3>Assumptions</h3>
              <Assumptions />
            </section>
          ) : null}
          {replyRelevant ? (
            <section className={styles.block}>
              <h3>Reply</h3>
              <Reply item={item} />
            </section>
          ) : null}
          <p className="small mute">{folderLabel ? `Folder: ${folderLabel}` : ""}</p>
        </details>
      </div>
    </main>
  );
}

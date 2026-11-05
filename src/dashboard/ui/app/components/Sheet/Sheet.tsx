// The sheet: everything the dashboard knows about the item the reader selected.
//
// It is laid out in two parts, and the split matters. The sticky header answers
// "what is this and what can I do about it" — identity and verdict
// (`SheetHeader.tsx`), actions, tabs
// — and never scrolls away. Below it, a stopped run first shows the question it
// asks (`Decision.tsx`), then exactly one tab is on screen at a time, followed
// by a collapsed panel holding what is true of the run but is not the question
// being asked: its metadata, its launch, its approval, its assumptions.
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
// it — the metadata, the launch, the approval, the assumptions —
// belongs to a tab, so closing it was an artifact of a renderer that rebuilt the
// subtree, not a decision. A reader who opened it keeps it open.

import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import type { JSX } from "react";
import { assumptionsQuery, detailQuery } from "../../api/queries.js";
import type { Item, ItemDetail } from "../../api/types.js";
import { splitKey } from "../../lib/items.js";
import { sheetSearchOf } from "../../lib/inbox-address.js";
import { currentSheetTab } from "../../lib/sheet.js";
import { findAssumptions, hasAssumptionContent } from "../../lib/work-item-tree.js";
import { DocumentView, Folder } from "../Explorer/index.js";
import { Actions } from "./Actions.js";
import { Approval } from "./Approval.js";
import { Assumptions } from "./Assumptions.js";
import { Decision, showsDecision } from "./Decision.js";
import { Launch } from "./Launch.js";
import { Meta } from "./Meta.js";
import { Report } from "./Report.js";
import { Run } from "./Run.js";
import styles from "./Sheet.module.css";
import { SheetHeader } from "./SheetHeader.js";
import { SheetContext, useSheet } from "./sheet-context.js";
import { SheetTabs } from "./SheetTabs.js";

/** The one tab on screen; the Run tab is the one every fallback ends on. */
function TabContent(): JSX.Element {
  const { detail, tab } = useSheet();
  const { item, steps, recap, tree, report } = detail;

  if (tab === "report" && report) {
    return (
      <section className={styles.primaryContent}>
        <Report item={item} report={report} {...(detail.reportWarnings ? { warnings: detail.reportWarnings } : {})} />
      </section>
    );
  }
  if (tab === "files") {
    return (
      <section className={styles.primaryContent}>
        <Folder />
      </section>
    );
  }
  if (tab === "document") {
    return (
      <section className={styles.primaryContent}>
        <DocumentView />
      </section>
    );
  }

  // A report that lists its captures shows them itself, labelled with their
  // criteria; the Run tab keeps the raw gallery only when it does not.
  const reportShowsCaptures = Boolean(report?.captures?.some((group) => group.files.length > 0));
  return (
    <section className={styles.primaryContent}>
      <Run item={item} recap={recap} steps={steps} tree={reportShowsCaptures ? null : tree} />
    </section>
  );
}

function Placeholder({ text }: { text: string }): JSX.Element {
  return (
    <main className={styles.sheet}>
      <p className="mute" style={{ padding: 40 }}>
        {text}
      </p>
    </main>
  );
}

/** The sheet of the item the inbox selected, `null` when no row is on screen.
 *  The detail is cached by item, so an answer that lands after the reader moved
 *  on is filed under its own item and never drawn over the sheet on screen. */
export function Sheet({ selected }: { selected: Item | null }): JSX.Element {
  const [project, ticket] = splitKey(selected?.key ?? "");
  const detail = useQuery({ ...detailQuery(project, ticket), enabled: selected !== null });

  if (!selected) return <Placeholder text="Nothing selected." />;
  if (detail.data) return <SheetBody detail={detail.data} />;
  if (detail.error) return <Placeholder text={`Could not read ${selected.ticket}: ${detail.error.message}`} />;
  return <Placeholder text="Loading…" />;
}

function SheetBody({ detail }: { detail: ItemDetail }): JSX.Element {
  const search = sheetSearchOf(useSearch({ strict: false }));
  const { item, tree } = detail;
  const tab = currentSheetTab(item, detail, search.tab ?? "auto");
  const filePath = search.file ?? tree?.gatePath ?? tree?.defaultPath ?? null;
  const assumptionsFile = tree ? findAssumptions(tree.children) : undefined;
  const assumptions = useQuery({
    ...assumptionsQuery(item, assumptionsFile?.path ?? ""),
    enabled: assumptionsFile !== undefined,
  });

  const folderLabel = tree ? `work-items/${item.ticket}/` : "";
  // A decision shows its approval and its reply in the panel above the tabs.
  const decision = showsDecision(item);
  const approvalRelevant = !decision && item.approval && item.approval.state !== "absent";

  return (
    <SheetContext value={{ item, detail, tab, filePath }}>
      <main className={styles.sheet}>
        <div className={styles.top}>
          <SheetHeader item={item} recap={detail.recap} />
          <Actions item={item} report={detail.report} className={styles.topActions} />
          <SheetTabs item={item} detail={detail} current={tab} />
        </div>
        <div className={styles.body}>
          {decision ? <Decision item={item} /> : null}
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
            {assumptions.data && hasAssumptionContent(assumptions.data) ? (
              <section className={styles.block}>
                <h3>Assumptions</h3>
                <Assumptions data={assumptions.data} />
              </section>
            ) : null}
            <p className="small mute">{folderLabel ? `Folder: ${folderLabel}` : ""}</p>
          </details>
        </div>
      </main>
    </SheetContext>
  );
}

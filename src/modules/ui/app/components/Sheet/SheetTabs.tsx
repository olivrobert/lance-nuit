// The tab bar of the sheet.
//
// A tab is listed only when it has something to show — there is no empty
// Document tab on a run that wrote no artifact — and the tab actually on screen
// is decided by `currentSheetTab`, not by this component: the reader's request
// may have to fall back when the run moves under them, and the bar has to
// highlight what is displayed rather than what was asked for.
//
// A `report.json` the read model refused leaves no Report tab; its one-line
// reason is shown in the tab's place instead, so a broken report is not
// mistaken for a run that wrote none.

import type { JSX } from "react";
import type { Item, ItemDetail, SheetTab } from "../../api/types.js";
import { countFiles } from "../../lib/derive.js";
import { actions } from "../../store/store.js";
import styles from "./Sheet.module.css";

export interface SheetTabsProps {
  item: Item;
  detail: ItemDetail;
  /** The tab actually shown, as resolved by `currentSheetTab`. */
  current: SheetTab;
}

export function SheetTabs({ item, detail, current }: SheetTabsProps): JSX.Element {
  const tree = detail.tree;
  const stepCount = detail.steps?.steps.length;
  const fileCount = tree ? tree.children.reduce((total, node) => total + countFiles(node), 0) : undefined;
  // [tab, label, available, count shown after the label]
  const tabs: [SheetTab, string, boolean, string?][] = [
    ["diagnostic", "Diagnostic", item.group === "failure" || Boolean(item.launch)],
    ["report", "Report", Boolean(detail.report)],
    ["run", "Run", Boolean(detail.recap || detail.steps), stepCount ? `${stepCount} steps` : undefined],
    ["document", "Document", Boolean(tree?.gatePath || tree?.defaultPath)],
    ["files", "Files", Boolean(tree), fileCount ? String(fileCount) : undefined],
  ];

  return (
    <nav className={styles.sheetTabs} aria-label="Run content">
      {!detail.report && detail.reportError ? (
        <span className={`${styles.tabNote} small mute`} title={detail.reportError}>
          {detail.reportError}
        </span>
      ) : null}
      {tabs
        .filter(([, , available]) => available)
        .map(([key, label, , count]) => (
          <button
            key={key}
            type="button"
            className={current === key ? styles.on : ""}
            aria-pressed={current === key}
            onClick={() => actions.setSheetTab(key)}
          >
            {label}
            {count ? <span className={styles.tabCount}>{count}</span> : null}
          </button>
        ))}
    </nav>
  );
}

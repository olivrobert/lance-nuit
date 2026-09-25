// The tab bar of the sheet.
//
// A tab is listed only when it has something to show — there is no empty
// Document tab on a run that wrote no artifact — and the tab actually on screen
// is decided by `currentSheetTab`, not by this component: the reader's request
// may have to fall back when the run moves under them, and the bar has to
// highlight what is displayed rather than what was asked for.

import type { JSX } from "react";
import type { Item, ItemDetail, SheetTab } from "../../api/types.js";
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
  const tabs: [SheetTab, string, boolean][] = [
    ["diagnostic", "Diagnostic", item.group === "failure" || Boolean(item.launch)],
    ["recap", "Recap", Boolean(detail.recap)],
    ["steps", "Steps", Boolean(detail.steps)],
    ["document", "Document", Boolean(tree?.gatePath || tree?.defaultPath)],
    ["files", "Files", Boolean(tree)],
  ];

  return (
    <nav className={styles.sheetTabs} aria-label="Run content">
      {tabs
        .filter(([, , available]) => available)
        .map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={current === key ? styles.on : ""}
            aria-pressed={current === key}
            onClick={() => actions.setSheetTab(key)}
          >
            {label}
          </button>
        ))}
    </nav>
  );
}

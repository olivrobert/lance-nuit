// The Document tab: the one file the tree names as the gate or the default,
// read on its own — no tree, no picker.
//
// No props, for the same reason as `Folder`: it is a sheet-tab component and
// reads the selected item's tree and file selection from the sheet context.

import type { JSX } from "react";
import { useSheet } from "../Sheet/sheet-context.js";
import styles from "./Explorer.module.css";
import { FileView } from "./FileView.js";

export function DocumentView(): JSX.Element {
  const { detail, filePath } = useSheet();
  const hasTree = Boolean(detail.tree);

  if (!filePath || !hasTree) return <p className="mute">No document to read for this run.</p>;

  return (
    <div className={styles.documentView}>
      <FileView headerClass={styles.documentVh} />
    </div>
  );
}

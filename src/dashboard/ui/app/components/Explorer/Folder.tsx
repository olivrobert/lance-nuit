// The Files tab: the directory tree and the read panel, side by side.
//
// No props — it is a sheet-tab component, so it reads its whole context (the
// selected item's tree, its own file selection) from the sheet context.

import type { JSX } from "react";
import { useSheet } from "../Sheet/sheet-context.js";
import styles from "./Explorer.module.css";
import { FileView } from "./FileView.js";
import { Tree } from "./Tree.js";

export function Folder(): JSX.Element {
  const tree = useSheet().detail.tree;

  if (!tree) return <p className="mute small">No readable folder for this item.</p>;

  return (
    <div className={styles.folder}>
      <nav className={styles.tree}>
        <Tree nodes={tree.children} />
      </nav>
      <div className={styles.view}>
        <FileView headerClass={styles.vh} />
      </div>
    </div>
  );
}

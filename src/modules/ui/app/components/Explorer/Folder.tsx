// The Files tab: the directory tree and the read panel, side by side.
//
// No props — it is a sheet-tab component, so it reads its whole context (the
// selected item's tree, its own file selection) straight off the store, the
// same way the vanilla `renderFolder` read the global `state` object.

import type { JSX } from "react";
import { useUiSelector } from "../../store/store.js";
import styles from "./Explorer.module.css";
import { FileView } from "./FileView.js";
import { Tree } from "./Tree.js";

export function Folder(): JSX.Element {
  const tree = useUiSelector((state) => state.detail?.tree ?? null);

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

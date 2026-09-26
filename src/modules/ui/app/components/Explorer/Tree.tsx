// The recursive file tree of one work item's directory.
//
// A directory's open state is not owned by this component: it lives in the
// store (`openDirs`) so it survives a poll and a tab switch, the same way the
// vanilla renderer kept it on the global `state` object rather than on the
// `<details>` node. `<details open>` is therefore driven by the store on every
// render, and `onToggle` — fired after the browser has already flipped the
// element, whether by a click or the keyboard — reports that back through
// `toggleDir` instead of ever being read back off the DOM.
//
// Each directory lists its children in the order `groupFiles` gives: markdown
// documents, the rest, then a "Machine files" fold whose open state is kept in
// `openDirs` too, under `machineFoldKey`.

import type { JSX } from "react";
import type { TreeNode } from "../../api/types.js";
import { cx } from "../../lib/cx.js";
import { countFiles } from "../../lib/derive.js";
import { fmtSize } from "../../lib/format.js";
import { useActions, useUiSelector } from "../../store/store.js";
import styles from "./Explorer.module.css";
import { groupFiles, isMachineFoldOpen, machineFoldKey } from "./file-groups.js";

/** A directory counts as open when the reader expanded it, or when it holds
 *  the selected file without being listed — same rule as the legacy `isOpen`. */
export function isOpen(path: string, openDirs: readonly string[], filePath: string | null): boolean {
  if (openDirs.includes(path)) return true;
  return typeof filePath === "string" && filePath.startsWith(`${path}/`);
}

/** One directory's children in reading order: markdown documents, then the
 *  rest, then the runner's own files folded under "Machine files". */
export function Tree({ nodes, path = "" }: { nodes: readonly TreeNode[]; path?: string }): JSX.Element {
  const openDirs = useUiSelector((state) => state.openDirs);
  const filePath = useUiSelector((state) => state.filePath);
  const actions = useActions();
  const { documents, others, machine } = groupFiles(nodes);

  return (
    <ul>
      <Rows nodes={documents} />
      <Rows nodes={others} />
      {machine.length > 0 ? (
        <li className={styles.machine}>
          <details
            open={isMachineFoldOpen(path, machine, openDirs, filePath)}
            onToggle={(event) => actions.toggleDir(machineFoldKey(path), event.currentTarget.open)}
          >
            <summary>
              Machine files
              <span className={styles.n}>{String(machine.reduce((total, node) => total + countFiles(node), 0))}</span>
            </summary>
            <ul>
              <Rows nodes={machine} />
            </ul>
          </details>
        </li>
      ) : null}
    </ul>
  );
}

function Rows({ nodes }: { nodes: readonly TreeNode[] }): JSX.Element {
  const openDirs = useUiSelector((state) => state.openDirs);
  const filePath = useUiSelector((state) => state.filePath);
  const actions = useActions();

  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "directory") {
          const count = countFiles(node);
          return (
            <li key={node.path}>
              <details
                open={isOpen(node.path, openDirs, filePath)}
                onToggle={(event) => actions.toggleDir(node.path, event.currentTarget.open)}
              >
                <summary>
                  {`${node.name}/`}
                  <span className={styles.n}>{String(count)}</span>
                </summary>
                {count > 0 ? (
                  <Tree nodes={node.children} path={node.path} />
                ) : (
                  <div className={styles.emptyDir}>empty</div>
                )}
              </details>
            </li>
          );
        }
        const className = cx(styles.f, node.path === filePath && styles.sel, node.gate && styles.hot);
        const open = () => actions.openFile(node.path);
        return (
          // The row, not the `<li>`, is the interactive element: an `<li>`
          // with a click handler is not keyboard-reachable, so the class the
          // legacy stylesheet put on `li.f` moves one level down, onto a real
          // `<button>` the `<li>` only wraps — reset back to a plain row in
          // `Explorer.module.css`.
          <li key={node.path}>
            <button type="button" className={className} title={node.path} onClick={open}>
              {node.name}
              <span className={styles.sz}>{fmtSize(node.size)}</span>
            </button>
          </li>
        );
      })}
    </>
  );
}

// The screenshots a run left under `reports/`, grouped by directory.
//
// Each image is loaded as raw bytes, lazily, so a long gallery costs nothing
// until it is scrolled to. A directory whose browser step left a summary beside
// its images offers to open it in the Files tab.

import type { JSX } from "react";
import { rawFileUrl } from "../../api/client.js";
import type { Item, WorkItemTree } from "../../api/types.js";
import { screenshotGroups } from "../../lib/derive.js";
import { actions } from "../../store/store.js";
import styles from "./Screenshots.module.css";

export function Screenshots({ item, tree }: { item: Item; tree: WorkItemTree | null }): JSX.Element | null {
  const groups = screenshotGroups(tree);
  if (groups.length === 0) return null;

  const openSummary = (path: string): void => {
    actions.openFile(path);
    actions.setSheetTab("files");
  };

  return (
    <section>
      <h3 className={styles.heading}>Screenshots</h3>
      {groups.map((group) => (
        <div key={group.dir} className={styles.group}>
          <div className="row">
            <code className="small mute">{group.dir}</code>
            <span className="grow" />
            {group.summary ? (
              <button type="button" className="small" onClick={() => openSummary(group.summary?.path ?? "")}>
                {`Open ${group.summary.name}`}
              </button>
            ) : null}
          </div>
          <div className={styles.gallery}>
            {group.images.map((image) => {
              const src = rawFileUrl(item, image.path);
              return (
                <a key={image.path} href={src} target="_blank" rel="noreferrer" title={image.name}>
                  <img src={src} alt={image.name} loading="lazy" />
                  <span className="small">{image.name}</span>
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

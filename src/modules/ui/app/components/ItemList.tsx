// The review inbox: one row per item, grouped by why it needs attention, in
// the reading order `GROUPS` defines (spec 4.1).
//
// A row drops its own project badge when a project chip is already active:
// the chip already says which project this list is, so repeating it on every
// row would be noise.

import type { JSX } from "react";
import { Fragment } from "react";
import type { Item } from "../api/types.js";
import { cx } from "../lib/cx.js";
import { GROUPS, isWaiting, reasonOf, visibleItems } from "../lib/derive.js";
import { fmtAge, fmtCost } from "../lib/format.js";
import { useActions, useUiSelector } from "../store/store.js";
import styles from "./ItemList.module.css";
import { ProjectBadge } from "./ProjectBadge.js";
import { StatusTag } from "./StatusTag.js";

function ItemRow({
  item,
  showProject,
  selected,
}: {
  item: Item;
  showProject: boolean;
  selected: boolean;
}): JSX.Element {
  const actions = useActions();
  return (
    <button
      type="button"
      className={cx(styles.it, styles[item.group], selected && styles.sel)}
      onClick={() => actions.select(item.key)}
    >
      <span className={styles.t}>
        {showProject ? <ProjectBadge name={item.project.name} /> : null}
        {item.ticket}
      </span>
      <StatusTag item={item} />
      <span className={styles.r}>{reasonOf(item)}</span>
      <span className={styles.m}>
        {`${item.pipeline} · ${fmtAge(item.updatedAt)} · ${fmtCost(item.cost)}${item.worktree ? " · worktree" : ""}`}
      </span>
    </button>
  );
}

export function ItemList(): JSX.Element {
  const items = useUiSelector((state) => state.items);
  const filter = useUiSelector((state) => state.filter);
  const queue = useUiSelector((state) => state.queue);
  const query = useUiSelector((state) => state.query);
  const projects = useUiSelector((state) => state.projects);
  const selected = useUiSelector((state) => state.selected);

  const rows = visibleItems(items, { filter, queue, query });
  const waiting = rows.filter(isWaiting).length;
  const scope = filter ?? `${projects.length} project${projects.length > 1 ? "s" : ""}`;
  const now = new Date().toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <aside className={styles.list}>
      <header>
        <h2>
          Review inbox <span className={styles.count}>{`· ${waiting} to review`}</span>
        </h2>
        <div className="small mute">{`${scope} · ${now}`}</div>
      </header>
      {GROUPS.map(([group, label]) => {
        const groupRows = rows.filter((item) => item.group === group);
        if (groupRows.length === 0) return null;
        return (
          <Fragment key={group}>
            <div className={cx(styles.grp, styles[group])}>
              {`${group === "decision" ? "⏸ " : ""}${label} (${groupRows.length})`}
            </div>
            {groupRows.map((item) => (
              <ItemRow key={item.key} item={item} showProject={!filter} selected={item.key === selected} />
            ))}
          </Fragment>
        );
      })}
      {rows.length === 0 ? (
        <p className="mute" style={{ padding: "16px" }}>
          Nothing to review.
        </p>
      ) : null}
    </aside>
  );
}

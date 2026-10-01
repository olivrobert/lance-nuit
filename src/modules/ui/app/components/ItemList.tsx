// The review inbox, read in morning order: what needs you, what is running,
// then one section per night (`timeline` decides which, and how each is named).
//
// `Needs you` and `Running` are plain sections: they are never collapsed. The
// nights are native `<details>`, which brings open/close and its keyboard for
// free. Their open state lives here, keyed on the stable section id, so a poll
// that reshuffles the rows never reopens what the reader closed.
//
// A row leads with the ticket title; the key moves to the meta line. It carries
// a tag only for an exception, and a project badge only when the rows on screen
// span several projects and no project chip already says which one this is.
//
// Rows carry `data-row-key` and the list `data-item-list`: `useListKeyboard`
// walks them to move the selection, so the DOM order is the keyboard order.
//
// The rows and the selection are the inbox's, handed down by `InboxScreen`:
// the list draws them and reports a click, it never decides what is selected.

import type { CSSProperties, JSX } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Item } from "../api/types.js";
import { cx } from "../lib/cx.js";
import { rowShowsTag, rowTime, timeline, type TimelineSection, type TimelineSectionId } from "../lib/inbox-timeline.js";
import { reasonOf } from "../lib/items.js";
import { fmtCost } from "../lib/format.js";
import { setQuery } from "../store/ui-store.js";
import styles from "./ItemList.module.css";
import { ProjectBadge } from "./ProjectBadge.js";
import { StatusTag } from "./StatusTag.js";

function ItemRow({
  item,
  sectionId,
  now,
  showProject,
  selected,
  onSelect,
}: {
  item: Item;
  sectionId: TimelineSectionId;
  now: Date;
  showProject: boolean;
  selected: boolean;
  onSelect(key: string): void;
}): JSX.Element {
  const meta = [item.title ? item.ticket : null, item.pipeline, rowTime(item, sectionId, now)];
  if (item.worktree) meta.push("worktree");
  return (
    <button
      type="button"
      className={cx(styles.it, styles[item.group], selected && styles.sel)}
      aria-current={selected ? "true" : undefined}
      data-row-key={item.key}
      onClick={() => onSelect(item.key)}
    >
      <span className={styles.t}>
        {showProject ? <ProjectBadge name={item.project.name} /> : null}
        {item.title ?? item.ticket}
      </span>
      <span className={styles.side}>
        {rowShowsTag(item) ? <StatusTag item={item} /> : null}
        <span className={styles.c}>{fmtCost(item.cost)}</span>
      </span>
      <span className={styles.m}>
        {meta.map((part, index) =>
          part === null ? null : (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, positional list of parts
            <span key={index} className={index === 0 && item.title ? styles.k : undefined}>
              {part}
            </span>
          ),
        )}
      </span>
      {item.group === "done" && !item.closed ? null : <span className={styles.r}>{reasonOf(item)}</span>}
    </button>
  );
}

function runs(count: number): string {
  return `${count} run${count === 1 ? "" : "s"}`;
}

/** `N runs · <cost>` on a night; the bare count on `Needs you` and `Running`. */
function sectionSummary(section: TimelineSection): string {
  if (section.id === "needs" || section.id === "running") return String(section.items.length);
  const cost = fmtCost(section.cost);
  return cost === "—" ? runs(section.items.length) : `${runs(section.items.length)} · ${cost}`;
}

function SectionHead({ section }: { section: TimelineSection }): JSX.Element {
  return (
    <>
      <span className={styles.l}>
        {section.label}
        {section.range ? <small>{section.range}</small> : null}
      </span>
      <span className={styles.s}>{sectionSummary(section)}</span>
    </>
  );
}

function EmptyList({
  total,
  query,
  filter,
  onShowAll,
}: {
  total: number;
  query: string;
  filter: string | null;
  onShowAll(): void;
}): JSX.Element {
  if (query.trim()) {
    return (
      <div className={styles.empty}>
        <p>{`No run matches “${query.trim()}”.`}</p>
        <button type="button" onClick={() => setQuery("")}>
          Clear search
        </button>
      </div>
    );
  }
  if (total > 0 && filter) {
    return (
      <div className={styles.empty}>
        <p>{`No run in ${filter}.`}</p>
        <button type="button" onClick={onShowAll}>
          Show every project
        </button>
      </div>
    );
  }
  return <p className={styles.empty}>No run yet.</p>;
}

/** Keeps `--list-head` on the list equal to its sticky header's height, so the
 *  section headers stick right under it however many lines the chips wrap to.
 *  The header is held through a callback ref: it mounts and unmounts with the
 *  sections, and the observer has to follow it. */
function useHeadHeight(): [(element: HTMLElement | null) => void, number] {
  const [head, setHead] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    // The observer reports the first size itself, before the next paint.
    if (!head || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(head.offsetHeight));
    observer.observe(head);
    return () => observer.disconnect();
  }, [head]);
  return [setHead, height];
}

export interface ItemListProps {
  /** The rows the chip and the search leave on screen. */
  rows: readonly Item[];
  /** Every item, whatever the filters: the empty state says which filter hid them. */
  total: number;
  filter: string | null;
  query: string;
  selected: string | null;
  onSelect(key: string): void;
  onShowAll(): void;
}

export function ItemList({ rows, total, filter, query, selected, onSelect, onShowAll }: ItemListProps): JSX.Element {
  // Only what the reader toggled; a section they never touched follows its default.
  const [opened, setOpened] = useState<Partial<Record<TimelineSectionId, boolean>>>({});
  const sectionRefs = useRef(new Map<TimelineSectionId, HTMLElement>());
  const now = new Date();
  const sections = timeline(rows, now);
  const hasHead = sections.length > 0 || query.trim() !== "";
  const [head, headHeight] = useHeadHeight();
  const showProject = !filter && new Set(rows.map((item) => item.project.name)).size > 1;
  // A section collapsed by default still opens when it is the only one: a
  // project whose runs are all old would otherwise show an empty-looking list.
  const isOpen = (section: TimelineSection): boolean =>
    opened[section.id] ?? (!section.collapsed || sections.length === 1);
  const setOpen = (id: TimelineSectionId, open: boolean): void => {
    setOpened((current) => (current[id] === open ? current : { ...current, [id]: open }));
  };

  const jump = (id: TimelineSectionId): void => {
    setOpen(id, true);
    // Once the section is open: scrolling first would stop short of a section
    // near the bottom, whose rows are not there yet to scroll past.
    setTimeout(() => sectionRefs.current.get(id)?.scrollIntoView({ block: "start" }), 0);
  };

  const register =
    (id: TimelineSectionId) =>
    (element: HTMLElement | null): void => {
      if (element) sectionRefs.current.set(id, element);
      else sectionRefs.current.delete(id);
    };

  const renderRows = (section: TimelineSection): JSX.Element[] =>
    section.items.map((item) => (
      <ItemRow
        key={item.key}
        item={item}
        sectionId={section.id}
        now={now}
        showProject={showProject}
        selected={item.key === selected}
        onSelect={onSelect}
      />
    ));

  return (
    <aside
      className={styles.list}
      data-item-list=""
      style={{ "--list-head": `${headHeight}px` } as CSSProperties}
      aria-label="Runs"
    >
      {hasHead ? (
        <header ref={head}>
          {query.trim() ? (
            <div className="small mute">{`${rows.length} match${rows.length === 1 ? "" : "es"}`}</div>
          ) : null}
          {sections.length > 0 ? (
            <nav className={styles.jumps} aria-label="Jump to">
              {sections.map((section) => (
                <button key={section.id} type="button" onClick={() => jump(section.id)}>
                  {section.label}
                  <span className={styles.n}>{section.items.length}</span>
                </button>
              ))}
            </nav>
          ) : null}
        </header>
      ) : null}
      {sections.map((section) =>
        section.id === "needs" || section.id === "running" ? (
          <section
            key={section.id}
            ref={register(section.id)}
            className={cx(styles.sec, section.id === "needs" && styles.pin)}
            aria-label={section.label}
          >
            <div className={styles.head}>
              <SectionHead section={section} />
            </div>
            {renderRows(section)}
          </section>
        ) : (
          <details
            key={section.id}
            ref={register(section.id)}
            className={styles.sec}
            open={isOpen(section)}
            onToggle={(event) => setOpen(section.id, event.currentTarget.open)}
          >
            <summary className={styles.head}>
              <SectionHead section={section} />
            </summary>
            {renderRows(section)}
          </details>
        ),
      )}
      {rows.length === 0 ? <EmptyList total={total} query={query} filter={filter} onShowAll={onShowAll} /> : null}
    </aside>
  );
}

// Search, one chip per project — a path that
// disappeared stays listed, greyed, with its own removal button (spec 4.2) —
// and the "Launch a run" button.
//
// The launch button takes its scope from the chips: a selected project locks
// the dialog to it, "All" makes the dialog ask. It is disabled without an
// identity, because the server signs the session with the reader's name, and
// without any reachable project, because there would be nothing to launch in.
//
// Adding and removing a project go through `useWriteProject`, which already
// toasts a refusal; this component only owns the `prompt()` that asks for the
// path, because a mutation has no business showing a browser dialog.
//
// The chip on screen is the inbox's address, handed down by `InboxScreen`; a
// click on a chip reports it, and the inbox moves the address.

import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { useState } from "react";
import { useWriteProject } from "../api/mutations.js";
import { itemsQuery, meQuery, projectsQuery } from "../api/queries.js";
import { cx } from "../lib/cx.js";
import { waitingCount } from "../lib/inbox.js";
import { setQuery, useUi } from "../store/ui-store.js";
import { LaunchRunDialog } from "./LaunchRunDialog.js";
import styles from "./ProjectBar.module.css";

const NONE: readonly never[] = [];

export interface ProjectBarProps {
  /** The chip on screen, `null` for every project. */
  filter: string | null;
  onFilter(name: string | null): void;
}

export function ProjectBar({ filter, onFilter }: ProjectBarProps): JSX.Element {
  const projects = useQuery(projectsQuery).data ?? NONE;
  const items = useQuery(itemsQuery).data ?? NONE;
  const user = useQuery(meQuery).data?.user ?? null;
  const query = useUi((state) => state.query);
  const writeProject = useWriteProject();
  const [launching, setLaunching] = useState(false);

  const launchable = projects.filter((project) => project.found);
  // A chip whose path disappeared is not a project anyone can launch in: the
  // dialog then asks, as it does from "All".
  const locked = filter && launchable.some((project) => project.name === filter) ? filter : null;
  const launchBlocked = !user
    ? "Choose who you are first: the session is signed with your name."
    : launchable.length === 0
      ? "Add a project first."
      : null;

  const addProject = (): void => {
    const path = prompt("Project path (the folder containing .lance-nuit):", "");
    if (!path) return;
    writeProject("add", path);
  };

  return (
    <div className={styles.projects}>
      <input
        className={styles.search}
        type="search"
        placeholder="Search ticket, title or pipeline…"
        aria-label="Search"
        data-list-search=""
        aria-keyshortcuts="/"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className={styles.chips}>
        <span className="small mute">Projects</span>
        <button type="button" className={cx(styles.chip, !filter && styles.on)} onClick={() => onFilter(null)}>
          {"All "}
          <small>{`· ${waitingCount(items, null)} to review`}</small>
        </button>
        {projects.map((project) =>
          project.found ? (
            <button
              key={project.name}
              type="button"
              className={cx(styles.chip, filter === project.name && styles.on)}
              title={`${project.cwd} · ${project.provider}${project.key ? ` ${project.key}` : ""}`}
              onClick={() => onFilter(project.name)}
            >
              <span className={styles.dot} />
              {project.name}
              <small>{` · ${waitingCount(items, project.name)}`}</small>
            </button>
          ) : (
            // A path that disappeared stays listed, greyed, and removable: the
            // reader decides whether the project moved or is gone for good.
            <span key={project.name} className={cx(styles.chip, styles.gone)} title={project.cwd}>
              <span className={styles.dot} />
              {project.name}
              <small>{" · unavailable"}</small>
              <button
                type="button"
                className={styles.drop}
                title="Remove this project from the list"
                onClick={() => writeProject("remove", project.cwd)}
              >
                {"×"}
              </button>
            </span>
          ),
        )}
        <button type="button" className={cx(styles.chip, styles.add)} onClick={addProject}>
          {"+ Add project"}
        </button>
      </div>
      {/* The title sits on a wrapper: a disabled button fires no pointer event,
          so its own tooltip would never show. */}
      <span title={launchBlocked ?? `Launch a run in ${locked ?? "a project"}`}>
        <button
          type="button"
          className="primary"
          disabled={launchBlocked !== null}
          aria-haspopup="dialog"
          onClick={() => setLaunching(true)}
        >
          Launch a run
        </button>
      </span>
      {launching ? <LaunchRunDialog projects={launchable} locked={locked} onClose={() => setLaunching(false)} /> : null}
      {user ? (
        <span className={styles.who} title="You">
          {user}
        </span>
      ) : null}
    </div>
  );
}

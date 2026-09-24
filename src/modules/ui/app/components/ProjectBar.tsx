// Search, the three queue tabs, one chip per project — a path that
// disappeared stays listed, greyed, with its own removal button (spec 4.2) —
// and the "Launch a run" button.
//
// The launch button takes its scope from the chips: a selected project locks
// the dialog to it, "All" makes the dialog ask. It is disabled without an
// identity, because the server signs the session with the reader's name, and
// without any reachable project, because there would be nothing to launch in.
//
// `addProject` and `removeProject` both go through the store, which already
// toasts a refusal; this component only owns the `prompt()` that asks for the
// path, because the store has no business showing a browser dialog.

import type { JSX } from "react";
import { useState } from "react";
import type { Queue } from "../api/types.js";
import { cx } from "../lib/cx.js";
import { queueCount, waitingCount } from "../lib/derive.js";
import { useActions, useUiSelector } from "../store/store.js";
import { LaunchRunDialog } from "./LaunchRunDialog.js";
import styles from "./ProjectBar.module.css";

const QUEUES: readonly (readonly [Queue, string])[] = [
  ["attention", "Attention"],
  ["running", "Running"],
  ["done", "Completed"],
];

export function ProjectBar(): JSX.Element {
  const projects = useUiSelector((state) => state.projects);
  const items = useUiSelector((state) => state.items);
  const filter = useUiSelector((state) => state.filter);
  const query = useUiSelector((state) => state.query);
  const queue = useUiSelector((state) => state.queue);
  const user = useUiSelector((state) => state.user);
  const actions = useActions();
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
    void actions.addProject(path);
  };

  return (
    <div className={styles.projects}>
      <input
        className={styles.search}
        type="search"
        placeholder="Search ticket or pipeline…"
        aria-label="Search"
        value={query}
        onChange={(event) => actions.setQuery(event.target.value)}
      />
      <nav className={styles.queues} aria-label="Filter runs">
        {QUEUES.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={cx(styles.queue, queue === key && styles.on)}
            aria-pressed={queue === key}
            onClick={() => actions.setQueue(key)}
          >
            {`${label} ${queueCount(items, key)}`}
          </button>
        ))}
      </nav>
      <div className={styles.chips}>
        <span className="small mute">Projects</span>
        <button type="button" className={cx(styles.chip, !filter && styles.on)} onClick={() => actions.setFilter(null)}>
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
              onClick={() => actions.setFilter(project.name)}
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
                onClick={() => void actions.removeProject(project.cwd)}
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

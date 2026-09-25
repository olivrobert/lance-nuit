// The "Launch a run" dialog: which project, which ticket, which pipeline, and
// whether in a worktree.
//
// What is launched is a tmux session on the server, in which the
// `lancenuit-operator` agent starts the run; the browser then moves to the
// terminal screen that shows that session. The server builds the command and
// validates every value — the ticket through the project's work-item provider —
// so the dialog only posts the four answers, and shows the server's refusal
// inline, next to the form it concerns, rather than in a toast that would
// disappear while the reader is still reading the field.
//
// THE PROJECT IS NEVER GUESSED. A dialog opened from a selected project chip is
// locked to that project, and its name is the title; opened from "All", it asks
// for one explicitly. The ticket field then warns — without blocking — when the
// typed prefix is not the project's key: launching a `FOOD-` ticket from the
// wrong project is the one mistake this form exists to make hard.
//
// Why the state is local and not in the store: the answers, the pipeline list
// and the pending flag belong to one opening of this form, are read by nothing
// else, and are thrown away when it closes. The fifteen second poll never
// repaints them, so the store's reasons for owning state do not apply.
//
// The native `<dialog>` element, opened with `showModal()`, gives the focus
// trap, the inert background and the Escape key for free, and focuses the first
// field — the project select from "All", the ticket otherwise. The focus goes
// back to the launch button when the dialog unmounts. It is closed by
// unmounting it: calling `close()` from an effect cleanup would fire a `close`
// event under Strict Mode's double mount and shut the dialog it just opened.

import type { FormEvent, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { fetchPipelines, postRun } from "../api/client.js";
import type { ProjectEntry } from "../api/types.js";
import { ticketPlaceholder, ticketPrefixMismatch } from "../lib/ticket.js";
import { navigate } from "../store/useRoute.js";
import styles from "./LaunchRunDialog.module.css";

export interface LaunchRunDialogProps {
  /** Projects that can be launched on: the ones whose path still exists. */
  projects: readonly ProjectEntry[];
  /** The selected chip. `null` means "All", and the dialog asks for a project. */
  locked: string | null;
  onClose(): void;
}

/** The pipeline list of the chosen project, as the select shows it. */
type Pipelines =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; names: string[] }
  | { status: "error"; error: string };

/** The pipeline preselected in a fresh list: `default` when the project has one. */
function preferredPipeline(names: readonly string[]): string {
  return names.includes("default") ? "default" : (names[0] ?? "");
}

/** Load the pipelines of one project, dropping an answer for a project the
 *  reader already switched away from. */
function usePipelines(project: string, onLoaded: (names: string[]) => void): Pipelines {
  const [pipelines, setPipelines] = useState<Pipelines>({ status: "idle" });
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;

  useEffect(() => {
    if (!project) {
      setPipelines({ status: "idle" });
      return;
    }
    let current = true;
    setPipelines({ status: "loading" });
    fetchPipelines(project)
      .then((result) => {
        if (!current) return;
        if (!result.ok || !Array.isArray(result.body.pipelines)) {
          setPipelines({ status: "error", error: result.body.error ?? `error ${result.status}` });
          return;
        }
        setPipelines({ status: "ok", names: result.body.pipelines });
        loaded.current(result.body.pipelines);
      })
      .catch((error: unknown) => {
        if (current) setPipelines({ status: "error", error: String(error) });
      });
    return () => {
      current = false;
    };
  }, [project]);

  return pipelines;
}

export function LaunchRunDialog({ projects, locked, onClose }: LaunchRunDialogProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [projectName, setProjectName] = useState(locked ?? "");
  const [ticket, setTicket] = useState("");
  const [pipeline, setPipeline] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pipelines = usePipelines(projectName, (names) => setPipeline(preferredPipeline(names)));

  // The element that opened the dialog, captured on the first render. A dialog
  // removed from the page while open does not hand the focus back by itself.
  const opener = useRef(document.activeElement);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    const previous = opener.current;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const project = projects.find((entry) => entry.name === projectName);
  const mismatch = ticketPrefixMismatch(ticket, project?.key);
  const ready = Boolean(project) && ticket.trim() !== "" && pipelines.status === "ok" && pipeline !== "" && !pending;

  const chooseProject = (name: string): void => {
    setProjectName(name);
    setPipeline("");
    setError(null);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready || !project) return;
    setPending(true);
    setError(null);
    try {
      const result = await postRun({ project: project.name, ticket: ticket.trim(), pipeline, worktree });
      const terminal = result.body.terminal;
      // 201 is a new session; 409 with a terminal is the session already running
      // for this ticket, which is exactly where the reader wants to be.
      if ((result.status === 201 || result.status === 409) && terminal?.id) {
        onClose();
        navigate({ view: "terminal", id: terminal.id });
        return;
      }
      setError(result.body.error ?? `The server refused the launch (error ${result.status}).`);
    } catch (failure) {
      setError(`The launch request failed: ${failure}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="launch-run-title" onClose={onClose}>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <h2 id="launch-run-title" className={styles.title}>
          {project ? (
            <>
              {"Launch a run in "}
              <span className={styles.project}>{project.name}</span>
            </>
          ) : (
            "Launch a run — choose a project"
          )}
        </h2>
        <p className="small mute">
          The lancenuit-operator agent starts the run in a tmux session on the server; you will see it here and can type
          into it.
        </p>

        {locked === null ? (
          <label className={styles.field}>
            <span>Project</span>
            <select required value={projectName} onChange={(event) => chooseProject(event.target.value)}>
              <option value="" disabled>
                Choose a project…
              </option>
              {projects.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.key ? `${entry.name} (${entry.key})` : entry.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className={styles.field}>
          <span>Ticket</span>
          <input
            type="text"
            required
            spellCheck={false}
            autoComplete="off"
            placeholder={ticketPlaceholder(project?.key)}
            value={ticket}
            onChange={(event) => setTicket(event.target.value)}
            aria-describedby={mismatch ? "launch-run-mismatch" : undefined}
          />
        </label>
        {mismatch && project ? (
          <p id="launch-run-mismatch" className={styles.warning} role="status">
            {`This ticket does not start with ${project.key}-: are you sure it belongs to ${project.name}?`}
          </p>
        ) : null}

        <label className={styles.field}>
          <span>Pipeline</span>
          <select
            required
            value={pipeline}
            disabled={pipelines.status !== "ok" || pipelines.names.length === 0}
            onChange={(event) => setPipeline(event.target.value)}
          >
            {pipelines.status === "ok" ? (
              pipelines.names.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))
            ) : (
              <option value="">{pipelines.status === "loading" ? "Loading…" : "—"}</option>
            )}
          </select>
        </label>
        {pipelines.status === "error" ? (
          <p className={styles.error}>{`Pipelines could not be read: ${pipelines.error}`}</p>
        ) : null}
        {pipelines.status === "ok" && pipelines.names.length === 0 ? (
          <p className={styles.error}>This project declares no pipeline.</p>
        ) : null}

        <label className={styles.check}>
          <input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.target.checked)} />
          <span>Run in a git worktree</span>
        </label>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.buttons}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            {pending ? "Launching…" : project ? `Launch in ${project.name}` : "Launch"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

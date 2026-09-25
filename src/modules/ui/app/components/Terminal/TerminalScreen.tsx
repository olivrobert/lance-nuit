// The terminal screen, at `#/terminal/<id>`: one tmux session, embedded.
//
// The header says which session this is — project first and large, because a
// reader typing into the wrong project's shell is the mistake to prevent — and
// carries the two things that exist outside the browser: the `attach` command,
// to take the same session over from a real terminal, and the kill button,
// which ends the session itself for every viewer. Leaving the screen does
// neither; it only detaches this page.
//
// The session record is read once, when the screen opens. It is not polled:
// what can change about it — that it ended — arrives through the stream.
// Like the pane, it is screen-local state read by nothing else, so it lives in
// this component and not in the store; the store is only used for its toast
// and clipboard, which every screen shares.

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { fetchTerminal, killTerminal } from "../../api/client.js";
import type { TerminalInfo } from "../../api/types.js";
import { fmtDate } from "../../lib/format.js";
import { useActions } from "../../store/store.js";
import styles from "./Terminal.module.css";
import { TerminalPane } from "./TerminalPane.js";

type Loaded = { status: "loading" } | { status: "ok"; terminal: TerminalInfo } | { status: "missing"; error: string };

function useTerminalInfo(id: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  useEffect(() => {
    let current = true;
    setLoaded({ status: "loading" });
    fetchTerminal(id)
      .then((result) => {
        if (!current) return;
        if (result.ok && result.body.id) setLoaded({ status: "ok", terminal: result.body as TerminalInfo });
        else
          setLoaded({
            status: "missing",
            error: result.status === 404 ? "" : (result.body.error ?? `error ${result.status}`),
          });
      })
      .catch((error: unknown) => {
        if (current) setLoaded({ status: "missing", error: String(error) });
      });
    return () => {
      current = false;
    };
  }, [id]);
  return loaded;
}

function Header({ terminal, ended }: { terminal: TerminalInfo; ended: boolean }): JSX.Element {
  const actions = useActions();
  const [killing, setKilling] = useState(false);

  const kill = async (): Promise<void> => {
    const sure = window.confirm(
      `Kill the tmux session of ${terminal.ticket} in ${terminal.project}?\n\nThe shell and everything running in it — the operator agent, the run — are stopped, for every viewer.`,
    );
    if (!sure) return;
    setKilling(true);
    try {
      const result = await killTerminal(terminal.id);
      actions.toast(result.ok ? "Session killed." : `Kill refused: ${result.body.error ?? result.status}`);
    } catch (error) {
      actions.toast(`Kill failed: ${error}`);
    } finally {
      setKilling(false);
    }
  };

  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <a href="#/" className={styles.back}>
          ← Inbox
        </a>
        <span className={styles.project}>{terminal.project}</span>
        <strong className={styles.ticket}>{terminal.ticket}</strong>
        <span className="tag absent">{terminal.pipeline}</span>
        {terminal.worktree ? <span className="tag RUNNING">worktree</span> : null}
        <span className="small mute">{`by ${terminal.by} · ${fmtDate(terminal.createdAt)}`}</span>
        <span className="grow" />
        <button type="button" className="danger" disabled={ended || killing} onClick={() => void kill()}>
          {killing ? "Killing…" : "Kill session"}
        </button>
      </div>
      <div className={styles.commands}>
        <code className={styles.command} title="Command typed into the session">
          {terminal.command}
        </code>
        <span className={styles.attach}>
          <code title="Attach from your own terminal">{terminal.attach}</code>
          <button type="button" className="small" onClick={() => void actions.copy(terminal.attach)}>
            copy
          </button>
        </span>
      </div>
    </header>
  );
}

export function TerminalScreen({ id }: { id: string }): JSX.Element {
  const loaded = useTerminalInfo(id);
  const [ended, setEnded] = useState(false);

  if (loaded.status === "loading") {
    return (
      <main className={styles.screen}>
        <p className={styles.message}>Loading the session…</p>
      </main>
    );
  }
  if (loaded.status === "missing") {
    return (
      <main className={styles.screen}>
        <div className={styles.message}>
          <p>{`No terminal session ${id}.${loaded.error ? ` (${loaded.error})` : " It may have ended."}`}</p>
          <a href="#/">Back to the inbox</a>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.screen}>
      <Header terminal={loaded.terminal} ended={ended} />
      <TerminalPane id={id} onEnded={() => setEnded(true)} />
    </main>
  );
}

// The terminal screen, at `#/terminal/<id>`: one tmux session, embedded.
//
// The header says which session this is — project first and large, because a
// reader typing into the wrong project's shell is the mistake to prevent — and
// carries the two things that exist outside the browser: the `attach` command,
// to take the same session over from a real terminal, and the kill button,
// which ends the session itself for every viewer. Leaving the screen does
// neither; it only detaches this page.
//
// The session record is read once, when the screen opens (`terminalQuery`). It
// is not polled: what can change about it — that it ended — arrives through
// the stream.

import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { useState } from "react";
import { killTerminal } from "../../api/client.js";
import { terminalQuery } from "../../api/queries.js";
import type { TerminalInfo } from "../../api/types.js";
import { fmtDate } from "../../lib/format.js";
import { copy, toast } from "../../store/ui-store.js";
import { InboxLink } from "../InboxLink.js";
import styles from "./Terminal.module.css";
import { TerminalPane } from "./TerminalPane.js";

function Header({ terminal, ended }: { terminal: TerminalInfo; ended: boolean }): JSX.Element {
  const [killing, setKilling] = useState(false);

  const kill = async (): Promise<void> => {
    const running = terminal.kind === "session" ? "the agent session" : "the operator agent, the run";
    const sure = window.confirm(
      `Kill the tmux session of ${terminal.ticket} in ${terminal.project}?\n\nThe shell and everything running in it — ${running} — are stopped, for every viewer.`,
    );
    if (!sure) return;
    setKilling(true);
    try {
      const result = await killTerminal(terminal.id);
      toast(result.ok ? "Session killed." : `Kill refused: ${result.error}`);
    } catch (error) {
      toast(`Kill failed: ${error}`);
    } finally {
      setKilling(false);
    }
  };

  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <InboxLink className={styles.back}>← Inbox</InboxLink>
        <span className={styles.project}>{terminal.project}</span>
        <strong className={styles.ticket}>{terminal.ticket}</strong>
        <span className="tag absent">{terminal.pipeline}</span>
        {terminal.kind === "session" ? <span className="tag absent">agent session</span> : null}
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
          <button type="button" className="small" onClick={() => void copy(terminal.attach)}>
            copy
          </button>
        </span>
      </div>
    </header>
  );
}

export function TerminalScreen({ id }: { id: string }): JSX.Element {
  const { data: terminal, error, isPending } = useQuery(terminalQuery(id));
  const [ended, setEnded] = useState(false);

  if (isPending) {
    return (
      <main className={styles.screen}>
        <p className={styles.message}>Loading the session…</p>
      </main>
    );
  }
  if (!terminal) {
    return (
      <main className={styles.screen}>
        <div className={styles.message}>
          <p>{`No terminal session ${id}.${error ? ` (${error.message})` : " It may have ended."}`}</p>
          <InboxLink>Back to the inbox</InboxLink>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.screen}>
      <Header terminal={terminal} ended={ended} />
      <TerminalPane id={id} onEnded={() => setEnded(true)} />
    </main>
  );
}

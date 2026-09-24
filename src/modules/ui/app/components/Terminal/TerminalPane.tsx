// One viewer of a tmux session: an xterm, fed by the terminal's SSE stream.
//
// The bridge is SSE for output and POSTs for input and resize (the server runs
// on a Bun whose `upgrade` does not carry a WebSocket). Each opening of this
// pane is one viewer on the server — its own `tmux attach` in a PTY — named by
// the unguessable token of the stream's `hello` event, which input and resize
// must carry. Closing the pane closes the stream and detaches that viewer; it
// never kills the session.
//
// Everything that has a lifetime — the xterm, the EventSource, the resize
// observer, the input batcher — is created and destroyed by ONE effect, keyed
// on the session id and the reconnect attempt. That is what makes cleanup
// complete by construction: there is no second place that could forget to close
// the stream. Reconnecting is a new attempt, hence a new xterm and a new
// viewer; tmux redraws the whole screen on attach, so nothing is lost.
//
// The session usually runs a full-screen TUI (the operator agent). xterm
// already forwards every key it receives — Escape, Ctrl+C, arrows, Shift+Tab,
// Enter — and nothing on this page listens to the keyboard, so none of them is
// stolen; the pane only has to take the focus when it opens.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { postTerminalInput, postTerminalResize, terminalStreamUrl } from "../../api/client.js";
import { clampSize, createInputBatcher, decodeDataEvent } from "../../lib/terminal-io.js";
import styles from "./Terminal.module.css";

/** Keystrokes arriving within this window leave in one POST. */
const INPUT_BATCH_MS = 10;

/** Quiet time after the last size change before the server is told. */
const RESIZE_DEBOUNCE_MS = 120;

/** Lines kept above the screen: a run's output is long, and tmux's own history
 *  is only reachable through its copy mode. */
const SCROLLBACK = 10000;

type Status = "connecting" | "live" | "lost" | "ended";

/** The monospace stack of `styles/tokens.css`, which xterm cannot inherit. */
function monoFont(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
  return value || "monospace";
}

export interface TerminalPaneProps {
  id: string;
  /** The session ended: the attach client exited because tmux closed it. */
  onEnded(): void;
}

export function TerminalPane({ id, onEnded }: TerminalPaneProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>("connecting");
  const [lostReason, setLostReason] = useState("");
  const ended = useRef(onEnded);
  ended.current = onEnded;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // `attempt` is read so a reconnect re-runs this effect with a fresh viewer.
    void attempt;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: monoFont(),
      fontSize: 13,
      scrollback: SCROLLBACK,
      macOptionIsMeta: true,
      theme: { background: "#1f2426", foreground: "#e6ebe8" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    term.focus();

    let viewer: string | null = null;
    let closed = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    // The stream is opened at this size; only a later change is posted.
    let sent = { cols: clampSize(term.cols), rows: clampSize(term.rows) };
    const source = new EventSource(terminalStreamUrl(id, sent.cols, sent.rows));

    /** Stop talking to the server, for whatever reason. Idempotent. */
    function stop(next: Status, reason = ""): void {
      if (closed) return;
      closed = true;
      source.close();
      batcher.cancel();
      setLostReason(reason);
      setStatus(next);
    }

    const batcher = createInputBatcher(async (data) => {
      if (!viewer || closed) return;
      const result = await postTerminalInput(id, viewer, data);
      if (!result.ok) stop("lost", result.body.error ?? `input refused (error ${result.status})`);
    }, INPUT_BATCH_MS);

    function sendResize(): void {
      if (!viewer || closed) return;
      const size = { cols: clampSize(term.cols), rows: clampSize(term.rows) };
      if (size.cols === sent.cols && size.rows === sent.rows) return;
      sent = size;
      void postTerminalResize(id, viewer, size.cols, size.rows).catch(() => undefined);
    }

    source.addEventListener("hello", (event) => {
      try {
        viewer = (JSON.parse((event as MessageEvent<string>).data) as { viewer?: string }).viewer ?? null;
      } catch {
        viewer = null;
      }
      if (!viewer) {
        stop("lost", "the server sent no viewer token");
        return;
      }
      setStatus("live");
      // The pane may have been resized while the stream was opening.
      sendResize();
    });
    source.addEventListener("data", (event) => {
      try {
        term.write(decodeDataEvent((event as MessageEvent<string>).data));
      } catch {
        // A frame that does not decode is dropped; the next redraw repairs it.
      }
    });
    source.addEventListener("exit", () => {
      stop("ended");
      ended.current();
    });
    source.onerror = () => stop("lost", "the stream was interrupted");

    const typed = term.onData((data) => batcher.push(data));
    const resized = term.onResize(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendResize, RESIZE_DEBOUNCE_MS);
    });
    const observer = new ResizeObserver(() => {
      // Fitting a pane that is not laid out (display: none, zero size) throws
      // inside the addon; the next observation will fit it.
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
    });
    observer.observe(element);

    return () => {
      closed = true;
      source.close();
      batcher.cancel();
      observer.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      typed.dispose();
      resized.dispose();
      term.dispose();
    };
  }, [id, attempt]);

  const reconnect = (): void => {
    setStatus("connecting");
    setLostReason("");
    setAttempt((value) => value + 1);
  };

  return (
    <div className={styles.pane}>
      {status === "connecting" ? <p className={styles.notice}>Connecting…</p> : null}
      {status === "lost" ? (
        <p className={`${styles.notice} ${styles.lost}`} role="alert">
          {`Connection lost${lostReason ? `: ${lostReason}` : ""}. The session keeps running on the server. `}
          <button type="button" onClick={reconnect}>
            Reconnect
          </button>
        </p>
      ) : null}
      {status === "ended" ? (
        <p className={`${styles.notice} ${styles.ended}`} role="status">
          {"Session ended. "}
          <a href="#/">Back to the inbox</a>
        </p>
      ) : null}
      <div ref={host} className={styles.xterm} />
    </div>
  );
}

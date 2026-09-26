// The fifteen second poll: the dashboard polls, it opens no SSE stream.
//
// The hook owns the timer and nothing else: the read itself, the signature
// comparison and the decision to repaint all live in the store, because a poll
// and a click must go through exactly the same code. What is here is the part
// React has to own — starting the loop when the shell mounts, and stopping it
// when it unmounts, including the extra mount/unmount that Strict Mode performs
// in development.
//
// The interval is NOT restarted by a poll that overruns: a slow answer is
// awaited before the next tick is scheduled, so a server under load never ends
// up with a queue of overlapping refreshes.
//
// A hidden tab is slowed down, never stopped: the count in its title and the
// notification of a run that needs a decision are the very reasons to leave the
// tab open in the background. Coming back to it reads the server at once rather
// than showing, for up to a minute, what was true when the reader left.

import { useEffect } from "react";
import { actions, HIDDEN_POLL_MS, POLL_MS } from "./store.js";

export function usePolling(intervalMs: number = POLL_MS, hiddenMs: number = HIDDEN_POLL_MS): void {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
      if (stopped) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void tick(false), document.hidden ? hiddenMs : intervalMs);
    };

    const tick = async (force: boolean): Promise<void> => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await actions.refresh(force);
      schedule();
    };

    const onVisible = (): void => {
      if (!document.hidden) void tick(false);
    };

    document.addEventListener("visibilitychange", onVisible);
    void tick(true);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== null) clearTimeout(timer);
    };
  }, [intervalMs, hiddenMs]);
}

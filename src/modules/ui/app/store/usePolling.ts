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

import { useEffect } from "react";
import { actions, POLL_MS } from "./store.js";

export function usePolling(intervalMs: number = POLL_MS): void {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (force: boolean): Promise<void> => {
      try {
        await actions.refresh(force);
      } catch {
        actions.toast("Refresh failed.");
      }
      if (stopped) return;
      timer = setTimeout(() => void tick(false), intervalMs);
    };

    void tick(true);

    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [intervalMs]);
}

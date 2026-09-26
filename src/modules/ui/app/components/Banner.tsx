// The status line at the top of the page: the name of the tool, whether what is
// on screen is current, and the switch for notifications.
//
// It carries no counts. The list's jump chips already say how many items wait,
// run and finished each night; a second copy of those numbers higher up was
// only something more to read.
//
// The document title (`(N) lancenuit — review inbox`) is set by `App`, not
// here: it is a property of the page, not of this header, and `App` already
// owns it because it is the one place that decides whether the shell is shown
// at all.

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { cx } from "../lib/cx.js";
import { freshnessOf, updatedLabel } from "../lib/derive.js";
import { useUiSelector } from "../store/store.js";
import { useNotificationPermission } from "../store/useAttentionNotifications.js";
import styles from "./Banner.module.css";

/** How often the age of the screen is re-read. The label counts in minutes, so
 *  a finer clock would only repaint the same words. */
const CLOCK_MS = 10_000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The age of the screen, and an alarm once reads stopped landing. */
function Freshness(): JSX.Element {
  const refreshedAt = useUiSelector((state) => state.refreshedAt);
  const refreshError = useUiSelector((state) => state.refreshError);
  // A read that lands re-renders this component through the store; the clock
  // only has to move the label between two reads.
  const now = Math.max(useNow(CLOCK_MS), refreshedAt ?? 0);
  const freshness = freshnessOf(refreshedAt, refreshError, now);
  const age = updatedLabel(refreshedAt, now);

  return (
    <span
      className={cx(styles.freshness, styles[freshness])}
      role="status"
      title={refreshError ?? (refreshedAt ? new Date(refreshedAt).toLocaleString() : "")}
    >
      <span className={styles.pulse} aria-hidden="true" />
      {freshness === "lost"
        ? `Server unreachable, retrying · ${age.toLowerCase()}`
        : freshness === "stale"
          ? `Not refreshed for a while · ${age.toLowerCase()}`
          : age}
    </span>
  );
}

/** Offered once: granted needs no button, and denied can only be undone in
 *  the browser's own settings. */
function NotifyToggle(): JSX.Element | null {
  const [permission, ask] = useNotificationPermission();
  if (permission !== "default") return null;
  return (
    <button
      type="button"
      className={styles.notify}
      title="Get a browser notification when a run needs a decision or fails while this tab is in the background"
      onClick={ask}
    >
      Notify me
    </button>
  );
}

export function Banner(): JSX.Element {
  return (
    <header className={styles.banner}>
      <strong>lancenuit</strong>
      <span className={styles.end}>
        <Freshness />
        <NotifyToggle />
      </span>
    </header>
  );
}

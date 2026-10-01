// The status line at the top of the page: the name of the tool, the links
// between screens, whether what is on screen is current, and the switch for
// notifications.
//
// It carries no counts. The list's jump chips already say how many items wait,
// run and finished each night; a second copy of those numbers higher up was
// only something more to read.
//
// The document title (`(N) lancenuit — review inbox`) is set by `App`, not
// here: it is a property of the page, not of this header.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { itemsQuery } from "../api/queries.js";
import { useNotificationPermission } from "../hooks/useAttentionNotifications.js";
import { cx } from "../lib/cx.js";
import { freshnessOf, updatedLabel } from "../lib/freshness.js";
import { InboxLink } from "./InboxLink.js";
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

/** The age of the screen, and an alarm once reads stopped landing. The item
 *  list stands for the whole poll: it is the read every screen depends on. */
function Freshness(): JSX.Element {
  const items = useQuery(itemsQuery);
  const refreshedAt = items.dataUpdatedAt || null;
  const refreshError = items.error ? items.error.message : null;
  // A read that lands re-renders this component through the query; the clock
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

/** The two screens a reader moves between on purpose. A terminal is reached
 *  from its item, never from here. */
function Nav({ screen }: { screen: BannerScreen }): JSX.Element {
  return (
    <nav className={styles.nav}>
      <InboxLink className={cx(screen === "inbox" && styles.current)}>Inbox</InboxLink>
      <Link to="/stats" className={cx(screen === "stats" && styles.current)}>
        Stats
      </Link>
    </nav>
  );
}

export type BannerScreen = "inbox" | "stats" | "terminal";

export function Banner({ screen }: { screen: BannerScreen }): JSX.Element {
  return (
    <header className={styles.banner}>
      <strong className={styles.brand}>
        <span className={styles.moon} aria-hidden="true" />
        lancenuit
      </strong>
      <Nav screen={screen} />
      <span className={styles.end}>
        <Freshness />
        <NotifyToggle />
      </span>
    </header>
  );
}

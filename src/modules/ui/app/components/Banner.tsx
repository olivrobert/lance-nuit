// The status line at the top of the page: a one-line summary and the three
// counts of the queue buttons below it, never a second alarm panel of its own.
//
// The document title (`(N) lancenuit — review inbox`) is set by `App`, not
// here: it is a property of the page, not of this header, and `App` already
// owns it because it is the one place that decides whether the shell is shown
// at all.

import type { JSX } from "react";
import { queueCount } from "../lib/derive.js";
import { useUiSelector } from "../store/store.js";
import styles from "./Banner.module.css";

export function Banner(): JSX.Element {
  const items = useUiSelector((state) => state.items);
  const attention = queueCount(items, "attention");
  const running = queueCount(items, "running");
  const done = queueCount(items, "done");

  return (
    <header className={styles.banner}>
      <strong>lancenuit</strong>
      <span className={styles.summary}>{attention ? `${attention} needs attention` : "Nothing needs attention"}</span>
      <span className={styles.counts}>
        <span className={styles.attention}>{`${attention} attention`}</span>
        <span className={styles.running}>{`${running} running`}</span>
        <span className={styles.done}>{`${done} completed`}</span>
      </span>
    </header>
  );
}

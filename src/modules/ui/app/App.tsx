// The shell.
//
// It answers two questions — is there a reader, and which screen does the URL
// hash name? — and then assembles the zones that screen lives in. The inbox is
// three zones; the stats screen (`#/stats`) keeps the banner and gives the rest
// to one table; the terminal screen (`#/terminal/<id>`) keeps the banner and
// gives the rest of the viewport to one tmux session. Identity comes first for
// both: the terminal is a shell, and nobody reaches it without a name. Everything else is delegated: the banner, the
// project bar, the list and the sheet each own their data through the store, so
// this file never passes props down and never has to be edited when one of them
// changes.
//
// The document title is set here rather than in the banner, because it is a
// property of the page and not of any component: `(N) lancenuit — review inbox`,
// with N the number of items waiting for a decision, is what a reader sees in a
// background tab.

import type { JSX } from "react";
import { useEffect } from "react";
import styles from "./App.module.css";
import { Banner } from "./components/Banner.js";
import { ItemList } from "./components/ItemList.js";
import { ProjectBar } from "./components/ProjectBar.js";
import { Sheet } from "./components/Sheet/index.js";
import { StatsScreen } from "./components/Stats/index.js";
import { TerminalScreen } from "./components/Terminal/index.js";
import { cx } from "./lib/cx.js";
import { waitingCount } from "./lib/derive.js";
import { POLL_MS, useActions, useUiState } from "./store/store.js";
import { useAttentionNotifications } from "./store/useAttentionNotifications.js";
import { useListKeyboard } from "./store/useListKeyboard.js";
import { usePolling } from "./store/usePolling.js";
import { useRoute } from "./store/useRoute.js";

/** "Who are you?" — the only screen shown before a name is chosen. The name
 *  signs approvals and launches, so nothing else is reachable without it. */
function Identity(): JSX.Element {
  const { users } = useUiState();
  const actions = useActions();

  return (
    <div className={styles.whoPage}>
      <h1>Who are you?</h1>
      <p className="mute">Your name signs approvals and launches. It is kept in a cookie for one year.</p>
      {users.length > 0 ? (
        <div className={styles.names}>
          {users.map((name) => (
            <button key={name} className="primary" type="button" onClick={() => void actions.chooseUser(name)}>
              {name}
            </button>
          ))}
        </div>
      ) : (
        <p className="mute small">No user configured. Add one to ~/.lance-nuit/ui/users.json, then reload the page.</p>
      )}
    </div>
  );
}

function ToastView(): JSX.Element | null {
  const { toast } = useUiState();
  if (!toast) return null;
  // `key` on the id, so the same message twice in a row still remounts and the
  // reader sees that something happened again.
  return (
    <div key={toast.id} className={styles.toast} role="status">
      {toast.message}
    </div>
  );
}

/** The number in the tab title: what is waiting for this reader, across every
 *  project, whatever chip is currently selected. */
function useDocumentTitle(count: number): void {
  useEffect(() => {
    document.title = `${count ? `(${count}) ` : ""}lancenuit — review inbox`;
  }, [count]);
}

export function App(): JSX.Element | null {
  const state = useUiState();
  const route = useRoute();
  usePolling();
  useAttentionNotifications();
  useListKeyboard(route.view === "inbox" && state.user !== null);
  useDocumentTitle(waitingCount(state.items, null));

  if (!state.loaded) {
    // Nothing was ever read: without this line the page stays blank, and a
    // blank page says nothing about a server that is down or a tunnel that dropped.
    return state.refreshError ? (
      <div className={styles.whoPage}>
        <h1>Dashboard server unreachable</h1>
        <p className="mute">{`Retrying every ${POLL_MS / 1000} seconds. Last error: ${state.refreshError}`}</p>
      </div>
    ) : (
      <ToastView />
    );
  }
  if (!state.user) {
    return (
      <>
        <Identity />
        <ToastView />
      </>
    );
  }

  if (route.view === "terminal") {
    // Keyed on the id: another session is another screen, never a pane reused
    // with a stale viewer token.
    return (
      <div className={cx(styles.shell, styles.terminalShell)}>
        <Banner />
        <TerminalScreen key={route.id} id={route.id} />
        <ToastView />
      </div>
    );
  }

  if (route.view === "stats") {
    return (
      <div className={cx(styles.shell, styles.statsShell)}>
        <Banner />
        <StatsScreen />
        <ToastView />
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <Banner />
      <ProjectBar />
      <div className={styles.mail}>
        <ItemList />
        <Sheet />
      </div>
      <ToastView />
    </div>
  );
}

// The shell.
//
// It answers exactly one question — is there a reader? — and then assembles the
// three zones the screens live in. Everything else is delegated: the banner, the
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
import { queueCount } from "./lib/derive.js";
import { useActions, useUiState } from "./store/store.js";
import { usePolling } from "./store/usePolling.js";

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
 *  project, whatever chip or queue is currently selected. */
function useDocumentTitle(count: number): void {
  useEffect(() => {
    document.title = `${count ? `(${count}) ` : ""}lancenuit — review inbox`;
  }, [count]);
}

export function App(): JSX.Element | null {
  const state = useUiState();
  usePolling();
  useDocumentTitle(queueCount(state.items, "attention"));

  if (!state.loaded) return <ToastView />;
  if (!state.user) {
    return (
      <>
        <Identity />
        <ToastView />
      </>
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

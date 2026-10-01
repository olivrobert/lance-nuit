// The screens around the routes.
//
// `Root` answers the one question every screen shares — is there a reader? —
// before the route is rendered at all: approvals and launches are signed with
// the reader's name, and the terminal is a shell, so nobody reaches either
// without one. The route then picks the screen; the inbox lays itself out
// (`InboxScreen`), the stats and terminal screens keep the banner and give it
// the rest of the viewport.
//
// The document title is set here rather than in the banner, because it is a
// property of the page and not of any component: `(N) lancenuit — review inbox`,
// with N the number of items waiting for a decision, is what a reader sees in a
// background tab.

import { useQuery } from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Outlet, useParams } from "@tanstack/react-router";
import type { JSX } from "react";
import { useEffect } from "react";
import styles from "./App.module.css";
import { useChooseUser } from "./api/mutations.js";
import { itemsQuery, meQuery, POLL_MS } from "./api/queries.js";
import { Banner } from "./components/Banner.js";
import { StatsScreen } from "./components/Stats/index.js";
import { TerminalScreen } from "./components/Terminal/index.js";
import { useAttentionNotifications } from "./hooks/useAttentionNotifications.js";
import { cx } from "./lib/cx.js";
import { waitingCount } from "./lib/inbox.js";
import { useUi } from "./store/ui-store.js";

/** "Who are you?" — the only screen shown before a name is chosen. The name
 *  signs approvals and launches, so nothing else is reachable without it. */
function Identity({ users }: { users: readonly string[] }): JSX.Element {
  const chooseUser = useChooseUser();
  return (
    <div className={styles.whoPage}>
      <h1>Who are you?</h1>
      <p className="mute">Your name signs approvals and launches. It is kept in a cookie for one year.</p>
      {users.length > 0 ? (
        <div className={styles.names}>
          {users.map((name) => (
            <button key={name} className="primary" type="button" onClick={() => chooseUser(name)}>
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
  const toast = useUi((state) => state.toast);
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
function useDocumentTitle(): void {
  const { data: items } = useQuery(itemsQuery);
  const count = items ? waitingCount(items, null) : 0;
  useEffect(() => {
    document.title = `${count ? `(${count}) ` : ""}lancenuit — review inbox`;
  }, [count]);
}

function SignedIn(): JSX.Element {
  useDocumentTitle();
  useAttentionNotifications();
  return (
    <>
      <Outlet />
      <ToastView />
    </>
  );
}

export function Root(): JSX.Element {
  const me = useQuery(meQuery);
  if (!me.data) {
    // Nothing was ever read: without this line the page stays blank, and a
    // blank page says nothing about a server that is down or a tunnel that dropped.
    return me.error ? (
      <div className={styles.whoPage}>
        <h1>Dashboard server unreachable</h1>
        <p className="mute">{`Retrying every ${POLL_MS / 1000} seconds. Last error: ${me.error.message}`}</p>
      </div>
    ) : (
      <ToastView />
    );
  }
  if (!me.data.user) {
    return (
      <>
        <Identity users={me.data.users} />
        <ToastView />
      </>
    );
  }
  return <SignedIn />;
}

export function StatsPage(): JSX.Element {
  return (
    <div className={cx(styles.shell, styles.statsShell)}>
      <Banner screen="stats" />
      <StatsScreen />
    </div>
  );
}

export function TerminalPage(): JSX.Element {
  const { id } = useParams({ from: "/terminal/$id" });
  // Keyed on the id: another session is another screen, never a pane reused
  // with a stale viewer token.
  return (
    <div className={cx(styles.shell, styles.terminalShell)}>
      <Banner screen="terminal" />
      <TerminalScreen key={id} id={id} />
    </div>
  );
}

/** What a render error leaves on screen, in place of the route that threw:
 *  the message, and a way back that does not need a reload. */
export function ErrorScreen({ error, reset }: ErrorComponentProps): JSX.Element {
  return (
    <div className={styles.whoPage}>
      <h1>This screen failed</h1>
      <p className="mute">{error instanceof Error ? error.message : String(error)}</p>
      <button type="button" className="primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}

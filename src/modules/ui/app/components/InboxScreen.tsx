// The inbox screen: the project bar, the list and the sheet, and the one
// component that knows which item is open.
//
// The address owns the view, the chip and the item (`lib/inbox-address.ts`).
// This screen reads it, lays the rows out, and resolves the item the sheet
// opens: the one the address names while it is on screen, in whichever view it
// is filed, else the first row of the view that wants the reader. When that
// resolution differs from the address — a chip on a project the server no
// longer lists, an item that vanished or moved to the other view, no item
// named yet — one effect writes the resolved address back, replacing the
// history entry, so the address bar always says what the screen shows and an
// automatic pick stays put on the next poll.
//
// A chip or a view change pushes a history entry, so the back button returns to
// the previous one. An item change replaces the current one: `j` held down
// would otherwise bury the previous page under a hundred entries.
//
// The screen is the parent of every inbox route, so moving between items keeps
// it mounted: the list keeps its scroll and the nights the reader folded.

import { useQuery } from "@tanstack/react-query";
import { useMatches, useNavigate } from "@tanstack/react-router";
import type { JSX } from "react";
import { useCallback, useEffect } from "react";
import styles from "../App.module.css";
import { itemsQuery, projectsQuery } from "../api/queries.js";
import { useDebounced } from "../hooks/useDebounced.js";
import { useListKeyboard } from "../hooks/useListKeyboard.js";
import { type InboxAddress, addressOf, inboxTarget, knownChip, resolveSelection } from "../lib/inbox-address.js";
import { type InboxView, viewOf, visibleItems } from "../lib/inbox.js";
import { nightSummary } from "../lib/inbox-timeline.js";
import { rememberInbox, useUi } from "../store/ui-store.js";
import { Banner } from "./Banner.js";
import { ItemList } from "./ItemList.js";
import { ProjectBar } from "./ProjectBar.js";
import { Sheet } from "./Sheet/index.js";

/** Idle time before a keystroke in the search box re-picks the selected item.
 *  The list filters on every keystroke; what is deferred is the jump to another
 *  item, which would otherwise fire mid-word. */
const SEARCH_DEBOUNCE_MS = 120;

const NONE: readonly never[] = [];

export function InboxScreen(): JSX.Element {
  const navigate = useNavigate();
  // The params and the path from one snapshot: read from two router stores, they
  // update apart, and the write-back below would act on half a navigation.
  const address = useMatches({
    select: (matches) => {
      const leaf = matches.at(-1);
      return addressOf(leaf?.params ?? {}, leaf?.pathname ?? "/");
    },
    structuralSharing: true,
  });
  const projects = useQuery(projectsQuery).data;
  const items = useQuery(itemsQuery).data;
  const query = useUi((state) => state.query);
  const settledQuery = useDebounced(query, SEARCH_DEBOUNCE_MS);

  // Before the projects are read the chip cannot be checked; it is taken as is.
  const chip = projects ? knownChip(address.chip, projects) : address.chip;
  const all = items ?? NONE;
  const rows = visibleItems(all, { filter: chip, query });
  const selectable = settledQuery === query ? rows : visibleItems(all, { filter: chip, query: settledQuery });
  const { view, item: selected } = resolveSelection(selectable, address.view, address.item);
  const loaded = projects !== undefined && items !== undefined;
  const resolvedItem = selected?.key ?? null;
  const inbox = rows.filter((item) => viewOf(item) === "inbox");
  const history = rows.filter((item) => viewOf(item) === "history");
  const night = nightSummary(history, new Date());

  const go = useCallback(
    (next: InboxAddress, replace: boolean): void => {
      // The tab and the file belong to the item: they follow it, and only it.
      const search = next.item === address.item ? true : undefined;
      void navigate({ ...inboxTarget(next), search, replace });
    },
    [navigate, address.item],
  );

  useEffect(() => {
    if (!loaded || (view === address.view && chip === address.chip && resolvedItem === address.item)) return;
    go({ view, chip, item: resolvedItem }, true);
  }, [loaded, view, chip, resolvedItem, address.view, address.chip, address.item, go]);

  useEffect(() => {
    if (loaded) rememberInbox({ view, chip, item: resolvedItem });
  }, [loaded, view, chip, resolvedItem]);

  const select = useCallback((key: string) => go({ view, chip, item: key }, true), [go, view, chip]);
  const filter = (name: string | null): void => {
    if (name !== chip) go({ view, chip: name, item: resolvedItem }, false);
  };
  // The open item belongs to the view it is filed in: another view opens its own first row.
  const switchView = (next: InboxView): void => {
    if (next !== view) go({ view: next, chip, item: null }, false);
  };
  useListKeyboard(resolvedItem, select);

  return (
    <div className={styles.shell}>
      <Banner screen="inbox" />
      <ProjectBar filter={chip} onFilter={filter} />
      <div className={styles.mail}>
        {loaded ? (
          <ItemList
            view={view}
            counts={{ inbox: inbox.length, history: history.length }}
            night={night}
            rows={view === "inbox" ? inbox : history}
            total={all.length}
            filter={chip}
            query={query}
            selected={resolvedItem}
            onSelect={select}
            onShowAll={() => filter(null)}
            onView={switchView}
          />
        ) : (
          <aside />
        )}
        <Sheet selected={loaded ? selected : null} />
      </div>
    </div>
  );
}

// The list's single-key shortcuts: `j`/`↓` and `k`/`↑` move the selection,
// `/` focuses the search, `Escape` in the search clears it and hands focus back
// to the list.
//
// Which key means what, and when a key belongs to something else, is decided by
// `lib/keyboard.ts`. This hook owns what only the browser has: the listener,
// the rows actually on screen — read from the DOM, because only the DOM knows
// which `<details>` the reader closed — and the scroll that keeps the selected
// row in view. It is mounted once, by `App`, and told whether the inbox is the
// screen shown: on the terminal screen every key belongs to the shell.

import { useEffect } from "react";
import { ignoresKey, listKeyOf, stepSelection } from "../lib/keyboard.js";
import { actions, useUiSelector } from "./store.js";

const SEARCH = "[data-list-search]";
const LIST = "[data-item-list]";

/** Keys of the rows the reader can see: every row outside a closed section. */
function visibleRowKeys(): string[] {
  const rows = document.querySelectorAll<HTMLElement>(`${LIST} [data-row-key]`);
  return [...rows]
    .filter((row) => row.closest("details:not([open])") === null)
    .map((row) => row.dataset.rowKey ?? "")
    .filter(Boolean);
}

function rowElement(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`${LIST} [data-row-key="${CSS.escape(key)}"]`);
}

function focusRow(key: string | null): boolean {
  const row = key ? rowElement(key) : null;
  if (!row) return false;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
  return true;
}

export function useListKeyboard(inbox: boolean): void {
  const selected = useUiSelector((state) => state.selected);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;

      if (event.key === "Escape" && inbox && target?.matches(SEARCH)) {
        event.preventDefault();
        actions.setQuery("");
        target.blur();
        // After the list re-rendered without the query: the selected row may
        // only exist again then. Without one on screen, the first row takes focus.
        setTimeout(() => {
          if (!focusRow(selected)) focusRow(visibleRowKeys()[0] ?? null);
        }, 0);
        return;
      }

      const intent = listKeyOf(event.key);
      if (!intent) return;
      const context = {
        key: event.key,
        targetTag: target?.tagName ?? null,
        targetEditable: target?.isContentEditable ?? false,
        targetInList:
          target === null ||
          target === document.body ||
          target === document.documentElement ||
          target.closest(LIST) !== null,
        dialogOpen: document.querySelector("dialog[open]") !== null,
        inbox,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      };
      if (ignoresKey(context)) return;
      event.preventDefault();

      if (intent === "search") {
        document.querySelector<HTMLInputElement>(SEARCH)?.focus();
        return;
      }
      const next = stepSelection(visibleRowKeys(), selected, intent);
      if (!next) return;
      if (next !== selected) actions.select(next);
      focusRow(next);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [inbox, selected]);
}

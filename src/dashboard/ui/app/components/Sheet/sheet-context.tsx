// What every part of the sheet reads about the open item: its detail, the tab
// on screen, the explorer file — and the one way to move between them.
//
// `Sheet` resolves it once and provides it, so a tab component deep in the tree
// neither re-reads the address nor re-derives the tab. The tab and the file are
// search params of the address (`?tab=files&file=…`), so a reload lands on the
// same file; moving between them replaces the history entry, as moving between
// items does, rather than burying the previous page under every click.

import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext } from "react";
import type { Item, ItemDetail, SheetTab } from "../../api/types.js";

export interface SheetContextValue {
  item: Item;
  detail: ItemDetail;
  /** The tab on screen, as `currentSheetTab` resolved it. */
  tab: SheetTab;
  /** The explorer file: the address's, else the tree's gate or default. */
  filePath: string | null;
}

export const SheetContext = createContext<SheetContextValue | null>(null);

export function useSheet(): SheetContextValue {
  const value = useContext(SheetContext);
  if (!value) throw new Error("useSheet is only valid inside the sheet");
  return value;
}

export interface SheetNavigation {
  showTab(tab: SheetTab): void;
  /** Open one file of the work item, in the tab given (the current one by default). */
  openFile(path: string, tab?: SheetTab): void;
}

export function useSheetNavigation(): SheetNavigation {
  const navigate = useNavigate();
  const go = (next: { tab?: SheetTab; file?: string }): void => {
    void navigate({ to: ".", search: (previous) => ({ ...previous, ...next }), replace: true });
  };
  return {
    showTab: (tab) => go({ tab }),
    openFile: (file, tab) => go(tab ? { tab, file } : { file }),
  };
}

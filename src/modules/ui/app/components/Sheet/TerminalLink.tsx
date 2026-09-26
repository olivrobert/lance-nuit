// "Open terminal": the way from an item to the tmux session running it.
//
// A session is looked up when the sheet opens on an item, and not polled: the
// list of sessions is read by this button alone, and a session started while
// the sheet is open was started from this page, which already moved to its
// terminal. The answer is dropped when the reader moved to another item before
// it arrived. A failed lookup shows nothing — the button is a shortcut, and the
// inbox works without it.

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { fetchTerminals } from "../../api/client.js";
import type { Item } from "../../api/types.js";
import { navigate } from "../../store/useRoute.js";

export function TerminalLink({ item, className }: { item: Item; className?: string }): JSX.Element | null {
  const project = item.project.name;
  const ticket = item.ticket;
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setId(null);
    fetchTerminals()
      .then((result) => {
        if (!current || !result.ok || !Array.isArray(result.body.terminals)) return;
        const found = result.body.terminals.find((entry) => entry.project === project && entry.ticket === ticket);
        setId(found?.id ?? null);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [project, ticket]);

  if (!id) return null;
  return (
    <button
      type="button"
      className={className}
      title="Show the tmux session of this item"
      onClick={() => navigate({ view: "terminal", id })}
    >
      Open terminal
    </button>
  );
}

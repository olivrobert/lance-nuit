// "Open terminal": the way from an item to the tmux session running it.
//
// A session is looked up when the sheet opens on an item, and not polled (see
// `terminalsQuery`). A failed lookup shows nothing — the button is a shortcut,
// and the inbox works without it.

import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { terminalsQuery } from "../../api/queries.js";
import type { Item } from "../../api/types.js";

export function TerminalLink({ item, className }: { item: Item; className?: string }): JSX.Element | null {
  const navigate = useNavigate();
  const terminals = useQuery(terminalsQuery).data;
  const id = terminals?.find((entry) => entry.project === item.project.name && entry.ticket === item.ticket)?.id;

  if (!id) return null;
  return (
    <button
      type="button"
      className={className}
      title="Show the tmux session of this item"
      onClick={() => void navigate({ to: "/terminal/$id", params: { id } })}
    >
      Open terminal
    </button>
  );
}

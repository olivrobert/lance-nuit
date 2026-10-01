// "Open coder session": the coder's conversation, reopened in a terminal.
//
// The server forks the session (`claude --resume --fork-session`) in the run's
// own directory, so the reader can ask the agent what it did without changing
// what the run would resume. The link is offered only once the run has stopped:
// while it runs, the agent is still writing to that conversation, and the server
// refuses it anyway. A session terminal already open for the item is reused.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { postCoderSession } from "../../api/client.js";
import { keys, terminalsQuery } from "../../api/queries.js";
import type { Item } from "../../api/types.js";
import { toast } from "../../store/ui-store.js";
import { useSheet } from "./sheet-context.js";

export function CoderSessionLink({ item, className }: { item: Item; className?: string }): JSX.Element | null {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const step = useSheet().detail.steps?.coderStep;
  const terminals = useQuery(terminalsQuery).data;
  const openId = terminals?.find(
    (entry) => entry.kind === "session" && entry.project === item.project.name && entry.ticket === item.ticket,
  )?.id;

  if (!step || item.group === "running") return null;

  const open = async (): Promise<void> => {
    if (openId) {
      void navigate({ to: "/terminal/$id", params: { id: openId } });
      return;
    }
    setPending(true);
    try {
      const result = await postCoderSession(item.project.name, item.ticket);
      const id = result.body.terminal?.id;
      // 409 with a terminal is a session opened since the list was read.
      if ((result.status === 201 || result.status === 409) && id) {
        void client.invalidateQueries({ queryKey: keys.terminals });
        void navigate({ to: "/terminal/$id", params: { id } });
        return;
      }
      toast(`Coder session refused: ${result.ok ? "the server answered without a session." : result.error}`);
    } catch (failure) {
      toast(`Coder session failed: ${failure}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      className={className}
      disabled={pending}
      title={`Resume a fork of the agent session of step ${step} in a terminal`}
      onClick={() => void open()}
    >
      {pending ? "Opening…" : "Open coder session"}
    </button>
  );
}

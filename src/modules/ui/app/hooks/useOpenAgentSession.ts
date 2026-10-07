// Open an agent session of an item's run in its terminal, the way the coder
// session link and a step's attempts do it.
//
// The request is always posted: the server answers 409 with the terminal when
// the same session is already open, which is where the reader goes. Looking the
// terminal up in the browser first would have to know how the server names each
// session terminal.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { postAgentSession, type StepAttemptTarget } from "../api/client.js";
import { keys } from "../api/queries.js";
import type { Item } from "../api/types.js";
import { toast } from "../store/ui-store.js";

export function useOpenAgentSession(item: Item): {
  pending: boolean;
  open: (target?: StepAttemptTarget) => Promise<void>;
} {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);

  const open = async (target?: StepAttemptTarget): Promise<void> => {
    setPending(true);
    try {
      const result = await postAgentSession(item.project.name, item.ticket, target);
      const id = result.body.terminal?.id;
      if ((result.status === 201 || result.status === 409) && id) {
        void client.invalidateQueries({ queryKey: keys.terminals });
        void navigate({ to: "/terminal/$id", params: { id } });
        return;
      }
      toast(`Agent session refused: ${result.ok ? "the server answered without a session." : result.error}`);
    } catch (failure) {
      toast(`Agent session failed: ${failure}`);
    } finally {
      setPending(false);
    }
  };

  return { pending, open };
}

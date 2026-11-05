// "Open coder session": the coder's conversation, reopened in a terminal.
//
// The server forks the session (`claude --resume --fork-session`) in the run's
// own directory, so the reader can ask the agent what it did without changing
// what the run would resume. The link is offered only once the run has stopped:
// while it runs, the agent is still writing to that conversation, and the server
// refuses it anyway. A session terminal already open for the item is reused.

import type { JSX } from "react";
import type { Item } from "../../api/types.js";
import { useOpenAgentSession } from "../../hooks/useOpenAgentSession.js";
import { useSheet } from "./sheet-context.js";

export function CoderSessionLink({ item, className }: { item: Item; className?: string }): JSX.Element | null {
  const { pending, open } = useOpenAgentSession(item);
  const step = useSheet().detail.steps?.coderStep;

  if (!step || item.group === "running") return null;

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

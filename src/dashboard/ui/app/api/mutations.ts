// Every write the dashboard makes, as TanStack Query mutations.
//
// A write answers with an `ApiResult`: a refusal is an answer, turned into a
// toast here, and only a network failure throws. Every write that moves the
// inbox re-reads it afterwards by invalidating the `inbox` prefix, so the
// reader sees the run start without waiting for the next poll.

import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { toast } from "../store/ui-store.js";
import { type ActionPayload, chooseUser, postAction, writeProject } from "./client.js";
import { keys } from "./queries.js";
import type { Item, VerbAction } from "./types.js";

const VERB_KEY = ["verb"] as const;

export interface VerbRequest {
  item: Item;
  verb: VerbAction;
  /** Required by the `budget` verb, asked for by the caller, which owns the prompt. */
  budget?: number;
  /** Required by the `reject-and-rerun` verb, asked for by the caller too. */
  reason?: string;
}

/** The body repeats the pipeline and the run id the sheet was showing, so a
 *  click on an item that moved since the last poll is refused by the server
 *  instead of applied to a run the reader never saw. */
function payloadOf({ item, verb, budget, reason }: VerbRequest): ActionPayload {
  const decides = verb.verb === "approve-and-rerun" || verb.verb === "approve" || verb.verb === "reject-and-rerun";
  const subject = decides ? item.stop?.subject : undefined;
  return {
    project: item.project.name,
    ticket: item.ticket,
    pipeline: item.pipeline,
    runId: item.runId,
    ...(subject !== undefined ? { subject } : {}),
    ...(typeof budget === "number" ? { budget } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

/** The verb being posted right now, wherever it was clicked: every action row
 *  of the page is disabled while one is in flight, which is what stops a double
 *  click from launching twice. */
export function usePendingVerb(): string | null {
  const pending = useMutationState({
    filters: { mutationKey: VERB_KEY, status: "pending" },
    select: (mutation) => (mutation.state.variables as VerbRequest | undefined)?.verb.verb ?? null,
  });
  return pending[0] ?? null;
}

export function useRunVerb(): (request: VerbRequest) => void {
  const client = useQueryClient();
  const { mutate } = useMutation({
    mutationKey: VERB_KEY,
    mutationFn: (request: VerbRequest) => postAction(request.verb.verb, payloadOf(request)),
    onSuccess: (result, request) => {
      if (!result.ok) {
        toast(`Rejected: ${result.error}`);
        return;
      }
      toast(`Started: ${request.verb.label} — the run is starting.`);
      void client.invalidateQueries({ queryKey: keys.inbox });
    },
    onError: (error) => {
      toast(`Launch failed: ${error}`);
      void client.invalidateQueries({ queryKey: keys.inbox });
    },
  });
  return (request) => {
    if (client.isMutating({ mutationKey: VERB_KEY }) > 0) return;
    mutate(request);
  };
}

export function useChooseUser(): (name: string) => void {
  const client = useQueryClient();
  const { mutate } = useMutation({
    mutationFn: chooseUser,
    onSuccess: (result) => {
      if (!result.ok) {
        toast(`Name rejected: ${result.error}`);
        return;
      }
      client.setQueryData(keys.me, result.body);
      void client.invalidateQueries({ queryKey: keys.inbox });
    },
    onError: (error) => toast(`Name rejected: ${error}`),
  });
  return mutate;
}

export function useWriteProject(): (action: "add" | "remove", path: string) => void {
  const client = useQueryClient();
  const { mutate } = useMutation({
    mutationFn: ({ action, path }: { action: "add" | "remove"; path: string }) => writeProject(action, path),
    onSuccess: (result, { action }) => {
      if (!result.ok) {
        toast(`${action === "add" ? "Project" : "Project removal"} rejected: ${result.error}`);
        return;
      }
      void client.invalidateQueries({ queryKey: keys.inbox });
    },
    onError: (error) => toast(`Project update failed: ${error}`),
  });
  return (action, path) => mutate({ action, path });
}

// Every server read the dashboard makes, as TanStack Query options.
//
// A read is named by its key: two components asking for the same key share one
// request and one cache entry, and an answer that lands after the reader moved to another item
// is filed under that item's key instead of overwriting the sheet on screen.
//
// THE POLL
// --------
// The dashboard polls, it opens no SSE stream. Every read under `inbox` carries
// the interval, so what is on screen is read again every fifteen seconds and
// what is not on screen is not read at all. A hidden tab is slowed down, never
// stopped: the count in its title and the notification of a run that needs a
// decision are the very reasons to leave it open in the background. Query
// re-aligns the timers of every observer of a key after each answer, so a key
// read by five components is still fetched once per interval.
//
// A failed read keeps the last good data (`data` stays, `error` is set), which
// is what the banner needs to say "stale" instead of emptying the inbox — an
// inbox that empties itself on one server error reads as "nothing to review".

import { QueryClient, queryOptions } from "@tanstack/react-query";
import {
  ApiError,
  fetchFile,
  fetchItemDetail,
  fetchItems,
  fetchLaunchLog,
  fetchMe,
  fetchPipelines,
  fetchProjects,
  fetchStats,
  fetchStepDetail,
  fetchTerminal,
  fetchTerminals,
} from "./client.js";
import type { Assumptions, FileView, Item, LaunchLog } from "./types.js";

/** Poll interval of the morning box. */
export const POLL_MS = 15000;

/** Poll interval while the tab is hidden: slow enough to cost nothing, fast
 *  enough for its title count and its notifications to stay useful. */
export const HIDDEN_POLL_MS = 60000;

/** Lines of a launch log shown in the sheet. */
export const LOG_LINES = 20;

function pollInterval(): number {
  return typeof document !== "undefined" && document.hidden ? HIDDEN_POLL_MS : POLL_MS;
}

const POLLED = { refetchInterval: pollInterval, refetchIntervalInBackground: true } as const;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The poll is the retry: three quick retries would only delay the
        // banner that says the server stopped answering.
        retry: false,
        // Long enough that a component mounting next to another one does not
        // read the key again; short enough that coming back to the tab does.
        staleTime: 5000,
      },
    },
  });
}

/** Keys, by prefix: invalidating `inbox` re-reads every screen of the inbox
 *  after a verb, without touching the stats. */
export const keys = {
  inbox: ["inbox"] as const,
  me: ["inbox", "me"] as const,
  projects: ["inbox", "projects"] as const,
  items: ["inbox", "items"] as const,
  detail: (project: string, ticket: string) => ["inbox", "item", project, ticket] as const,
  file: (project: string, ticket: string, path: string, render: "html" | "raw") =>
    ["inbox", "item", project, ticket, "file", render, path] as const,
  step: (project: string, ticket: string, stepId: string, attempt: number | "last") =>
    ["inbox", "item", project, ticket, "step", stepId, attempt] as const,
  launchLog: (id: string) => ["inbox", "launch-log", id] as const,
  terminals: ["terminals"] as const,
  terminal: (id: string) => ["terminals", id] as const,
  pipelines: (project: string) => ["pipelines", project] as const,
  stats: ["stats"] as const,
};

export const meQuery = queryOptions({ queryKey: keys.me, queryFn: fetchMe, ...POLLED });

export const projectsQuery = queryOptions({
  queryKey: keys.projects,
  queryFn: async () => (await fetchProjects()).projects,
  ...POLLED,
});

export const itemsQuery = queryOptions({
  queryKey: keys.items,
  queryFn: async () => (await fetchItems()).items,
  ...POLLED,
});

export function detailQuery(project: string, ticket: string) {
  return queryOptions({
    queryKey: keys.detail(project, ticket),
    queryFn: () => fetchItemDetail(project, ticket),
    ...POLLED,
  });
}

/** One explorer file. A refusal is part of what the panel shows, so it is an
 *  answer here, not an error. */
export function fileQuery(item: Pick<Item, "project" | "ticket">, path: string) {
  return queryOptions({
    queryKey: keys.file(item.project.name, item.ticket, path, "html"),
    queryFn: async (): Promise<FileView> => {
      try {
        return await fetchFile(item, path, "html");
      } catch (error) {
        if (error instanceof ApiError) return { status: "error", error: error.message };
        throw error;
      }
    },
    ...POLLED,
  });
}

/** `assumptions.json`, parsed. A missing or hand-edited file that no longer
 *  parses simply shows as absent. */
export function assumptionsQuery(item: Pick<Item, "project" | "ticket">, path: string) {
  return queryOptions({
    queryKey: keys.file(item.project.name, item.ticket, path, "raw"),
    queryFn: async (): Promise<Assumptions | null> => {
      const file = await fetchFile(item, path, "raw").catch(() => null);
      if (file?.status !== "ok" || typeof file.content !== "string") return null;
      try {
        return JSON.parse(file.content) as Assumptions;
      } catch {
        return null;
      }
    },
    ...POLLED,
  });
}

/** One step opened from the timeline. Polled like the rest of the sheet, but
 *  only while the step is open: the read parses the whole run journal. */
export function stepDetailQuery(item: Pick<Item, "project" | "ticket">, stepId: string, attempt?: number) {
  return queryOptions({
    queryKey: keys.step(item.project.name, item.ticket, stepId, attempt ?? "last"),
    queryFn: () => fetchStepDetail(item, stepId, attempt),
    ...POLLED,
  });
}

export function launchLogQuery(id: string) {
  return queryOptions({
    queryKey: keys.launchLog(id),
    queryFn: async (): Promise<LaunchLog> => {
      try {
        return { ...(await fetchLaunchLog(id, LOG_LINES)), status: "ok", id };
      } catch (error) {
        if (error instanceof ApiError) return { status: "not-found", id };
        throw error;
      }
    },
    ...POLLED,
  });
}

/** The running sessions, to find the one of an item. Read when a sheet opens,
 *  not polled: a session started while the sheet is open was started from this
 *  page, which invalidates this key and moves to its terminal. */
export const terminalsQuery = queryOptions({
  queryKey: keys.terminals,
  queryFn: async () => (await fetchTerminals()).terminals,
});

/** One session, read once when its screen opens. What can change about it —
 *  that it ended — arrives through its stream. A 404 is an answer: the
 *  session is gone, which the screen says in its own words. */
export function terminalQuery(id: string) {
  return queryOptions({
    queryKey: keys.terminal(id),
    queryFn: async () => {
      try {
        return await fetchTerminal(id);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function pipelinesQuery(project: string) {
  return queryOptions({
    queryKey: keys.pipelines(project),
    queryFn: async () => (await fetchPipelines(project)).pipelines,
  });
}

/** Read when the stats screen opens and on its Refresh button, never polled:
 *  it reads every run on disk. */
export const statsQuery = queryOptions({ queryKey: keys.stats, queryFn: fetchStats, staleTime: 0 });

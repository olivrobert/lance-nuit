// The two races the store exists to win, driven against a hand-resolved API.
//
// Nothing here touches `fetch` or React: `createUiStore` takes the API as an
// argument, and the fake below records every call and, for the methods a test
// asks it to hold, answers only when the test says so. That is what lets a test
// order "the reader moved on" before "the old answer arrives".

import { describe, expect, test } from "bun:test";
import type { ApiResult } from "../api/client.js";
import type { Item, ItemDetail, VerbAction } from "../api/types.js";
import { createUiStore, type UiApi } from "./create-store.js";

function makeItem(ticket: string, overrides: Partial<Item> = {}): Item {
  return {
    key: `web/${ticket}`,
    project: { name: "web", cwd: "/srv/web", provider: "local" },
    ticket,
    pipeline: "feature",
    runId: `run-${ticket}`,
    status: "STOPPED",
    group: "decision",
    cost: { estimated: false },
    updatedAt: "2026-01-10T10:00:00.000Z",
    worktree: false,
    effectiveWorkItemDir: `/srv/web/work-items/${ticket}`,
    ...overrides,
  };
}

const A = makeItem("A");
const B = makeItem("B");
const RERUN: VerbAction = { verb: "rerun", label: "Rerun", command: "lancenuit run A" };

/** Let every promise that can settle, settle. */
async function flush(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0));
}

interface Call {
  name: keyof UiApi;
  args: unknown[];
  /** Answer the call. A held call stays pending until this is called. */
  release(): void;
}

interface Scenario {
  user?: string | null;
  items?: Item[];
  details?: Record<string, ItemDetail>;
}

/** An API whose every method answers from the scenario, at once unless held. */
function fakeApi(scenario: Scenario = {}) {
  const calls: Call[] = [];
  const holding = new Set<keyof UiApi>();
  const failing = new Map<keyof UiApi, string>();

  function answer<T>(name: keyof UiApi, args: unknown[], body: unknown, ok = true): Promise<ApiResult<T>> {
    const failure = failing.get(name);
    const result: ApiResult<T> = failure
      ? { ok: false, status: 409, body: { error: failure } as ApiResult<T>["body"] }
      : { ok, status: ok ? 200 : 404, body: body as ApiResult<T>["body"] };
    let settle!: (value: ApiResult<T>) => void;
    const promise = new Promise<ApiResult<T>>((fulfil) => {
      settle = fulfil;
    });
    const call: Call = { name, args, release: () => settle(result) };
    calls.push(call);
    if (!holding.has(name)) call.release();
    return promise;
  }

  const users = ["olivier"];
  const user = scenario.user === undefined ? "olivier" : scenario.user;
  const api: UiApi = {
    fetchMe: () => answer("fetchMe", [], { user, users }),
    chooseUser: (name) => answer("chooseUser", [name], { user: name, users }),
    fetchProjects: () => answer("fetchProjects", [], { projects: [] }),
    fetchItems: () => answer("fetchItems", [], { items: scenario.items ?? [] }),
    fetchItemDetail: (project, ticket) => {
      const detail = scenario.details?.[`${project}/${ticket}`];
      return answer("fetchItemDetail", [project, ticket], detail ?? {}, detail !== undefined);
    },
    fetchFile: (item, path) => answer("fetchFile", [item.ticket, path], { status: "error", error: "none" }, false),
    fetchLaunchLog: (id) => answer("fetchLaunchLog", [id], { status: "not-found" }, false),
    postAction: (verb, payload) => answer("postAction", [verb, payload], {}),
    writeProject: (action, path) => answer("writeProject", [action, path], { projects: [] }),
  };

  return {
    api,
    calls,
    /** Mutable on purpose: a test changes what the next poll will read. */
    scenario,
    hold: (name: keyof UiApi) => holding.add(name),
    fail: (name: keyof UiApi, error: string) => failing.set(name, error),
    failing,
    of: (name: keyof UiApi) => calls.filter((call) => call.name === name),
    names: () => calls.map((call) => call.name),
  };
}

const DETAILS: Record<string, ItemDetail> = {
  "web/A": { item: A, tree: null, steps: null, recap: null, report: null },
  "web/B": { item: B, tree: null, steps: null, recap: null, report: null },
};

describe("a detail answer that arrives after the reader moved on", () => {
  test("is dropped, and the new selection's answer is the one rendered", async () => {
    const fake = fakeApi({ items: [A, B], details: DETAILS });
    fake.hold("fetchItemDetail");
    const store = createUiStore(fake.api);

    const poll = store.actions.refresh();
    await flush();
    // The box opened on A, and A's detail is on the wire.
    expect(store.getSnapshot().selected).toBe("web/A");
    expect(fake.of("fetchItemDetail").map((call) => call.args)).toEqual([["web", "A"]]);

    store.actions.select("web/B");
    await flush();
    const [detailA, detailB] = fake.of("fetchItemDetail");
    expect(detailB?.args).toEqual(["web", "B"]);

    // A's answer lands late: nothing is written under the reader.
    detailA?.release();
    await flush();
    expect(store.getSnapshot().selected).toBe("web/B");
    expect(store.getSnapshot().detail).toBeNull();

    detailB?.release();
    await flush();
    await poll;
    expect(store.getSnapshot().detail?.item.key).toBe("web/B");
  });

  test("a late answer for the same selection but an older token is dropped too", async () => {
    const fake = fakeApi({ items: [A, B], details: DETAILS });
    fake.hold("fetchItemDetail");
    const store = createUiStore(fake.api);

    const poll = store.actions.refresh();
    await flush();
    // A -> B -> A: the reader is back on A, but the first request was for a
    // sheet they left. Only the third answer may be rendered.
    store.actions.select("web/B");
    await flush();
    store.actions.select("web/A");
    await flush();
    const [first, second, third] = fake.of("fetchItemDetail");
    expect(third?.args).toEqual(["web", "A"]);

    first?.release();
    second?.release();
    await flush();
    expect(store.getSnapshot().detail).toBeNull();

    third?.release();
    await flush();
    await poll;
    expect(store.getSnapshot().detail?.item.key).toBe("web/A");
  });
});

describe("a verb posted while a poll is in flight", () => {
  test("posts at once, but its refresh waits for the poll to finish", async () => {
    const fake = fakeApi({ items: [A], details: DETAILS });
    fake.hold("fetchMe");
    const store = createUiStore(fake.api);

    const poll = store.actions.refresh();
    await flush();
    expect(fake.of("fetchMe")).toHaveLength(1);

    const verb = store.actions.runVerb(A, RERUN);
    await flush();
    // The click went out and the buttons are back, without waiting for the poll.
    expect(fake.of("postAction").map((call) => call.args[0])).toEqual(["rerun"]);
    expect(store.getSnapshot().pending).toBeNull();
    expect(store.getSnapshot().toast?.message).toBe("Started: Rerun — the run is starting.");
    // Its refresh has NOT started: one read at a time.
    expect(fake.of("fetchMe")).toHaveLength(1);

    fake.of("fetchMe")[0]?.release();
    await flush();
    await poll;
    // The poll's read completed whole before the verb's read began.
    expect(fake.of("fetchMe")).toHaveLength(2);

    fake.of("fetchMe")[1]?.release();
    await verb;
    expect(fake.names()).toEqual([
      "fetchMe",
      "postAction",
      "fetchProjects",
      "fetchItems",
      "fetchItemDetail",
      "fetchMe",
      "fetchProjects",
      "fetchItems",
      "fetchItemDetail",
    ]);
    expect(store.getSnapshot().loaded).toBe(true);
    expect(store.getSnapshot().detail?.item.key).toBe("web/A");
  });

  test("a second click while the first is pending posts nothing", async () => {
    const fake = fakeApi({ items: [A], details: DETAILS });
    fake.hold("postAction");
    const store = createUiStore(fake.api);
    await store.actions.refresh();

    const first = store.actions.runVerb(A, RERUN);
    await flush();
    expect(store.getSnapshot().pending).toBe("rerun");
    await store.actions.runVerb(A, RERUN);
    expect(fake.of("postAction")).toHaveLength(1);

    fake.of("postAction")[0]?.release();
    await first;
    expect(store.getSnapshot().pending).toBeNull();
  });

  test("a refused verb shows the server's reason and reads nothing again", async () => {
    const fake = fakeApi({ items: [A], details: DETAILS });
    const store = createUiStore(fake.api);
    await store.actions.refresh();
    const reads = fake.calls.length;

    fake.fail("postAction", "the item's run changed; reload the page");
    await store.actions.runVerb(A, RERUN);
    expect(store.getSnapshot().pending).toBeNull();
    expect(store.getSnapshot().toast?.message).toBe("Rejected: the item's run changed; reload the page");
    expect(fake.calls.length).toBe(reads + 1);
  });
});

describe("the poll and the screen", () => {
  test("an idle poll repaints nothing; a forced one always does", async () => {
    const fake = fakeApi({ items: [A], details: DETAILS });
    const store = createUiStore(fake.api);
    let repaints = 0;
    store.subscribe(() => {
      repaints += 1;
    });

    await store.actions.refresh();
    expect(repaints).toBe(1);
    await store.actions.refresh();
    expect(repaints).toBe(1);
    await store.actions.refresh(true);
    expect(repaints).toBe(2);
  });

  test("without a user, the poll stops at the identity and shows the shell", async () => {
    const fake = fakeApi({ user: null, items: [A] });
    const store = createUiStore(fake.api);
    await store.actions.refresh();
    expect(store.getSnapshot()).toMatchObject({ user: null, loaded: true, items: [], selected: null });
    expect(fake.names()).toEqual(["fetchMe"]);
  });

  test("a selected item that left the box hands the sheet to the first waiting one", async () => {
    const fake = fakeApi({ items: [A, B], details: DETAILS });
    const store = createUiStore(fake.api);
    await store.actions.refresh();
    store.actions.select("web/B");
    await flush();
    expect(store.getSnapshot().detail?.item.key).toBe("web/B");

    // Next poll: B is gone from the box.
    fake.scenario.items = [A];
    await store.actions.refresh();
    expect(store.getSnapshot().selected).toBe("web/A");
    expect(store.getSnapshot().detail?.item.key).toBe("web/A");
  });
});

describe("a refresh that fails", () => {
  test("keeps the inbox on screen and says the server is unreachable", async () => {
    const fake = fakeApi({ items: [A, B], details: DETAILS });
    const store = createUiStore(fake.api);
    await store.actions.refresh();
    expect(store.getSnapshot()).toMatchObject({ refreshError: null, items: [A, B] });
    expect(store.getSnapshot().refreshedAt).not.toBeNull();

    fake.fail("fetchItems", "server restarting");
    await store.actions.refresh();
    expect(store.getSnapshot()).toMatchObject({ refreshError: "server restarting", items: [A, B] });

    fake.failing.delete("fetchItems");
    await store.actions.refresh();
    expect(store.getSnapshot().refreshError).toBeNull();
  });

  test("never rejects when the network itself fails", async () => {
    const fake = fakeApi({ items: [A] });
    const store = createUiStore({
      ...fake.api,
      fetchMe: () => Promise.reject(new Error("Failed to fetch")),
    });
    await store.actions.refresh();
    expect(store.getSnapshot()).toMatchObject({ refreshError: "Failed to fetch", loaded: false });
  });
});

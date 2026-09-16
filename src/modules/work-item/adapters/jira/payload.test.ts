import { describe, expect, it } from "bun:test";
import type { AutomationQueue, WorkItemState } from "../../../../contracts/work-items.js";
import { createJiraWorkItemGateway, parseAcliTicketKeys } from "./index.js";
import {
  commandsMatching,
  createAcliSim,
  DEFAULT_SEED,
  FAKE_CONVERTER,
  harness,
  ko,
  messageOf,
  NO_CONVERTER,
  ok,
  stubbed,
} from "./test-harness.js";

describe("jira gateway — JQL", () => {
  const jqlFor = async (queue: AutomationQueue, state: WorkItemState): Promise<string> => {
    const { gateway, sim } = harness();
    await gateway.findCandidates({ queue, state });
    const search = sim.commands.find((command) => command[3] === "search")!;
    return search[search.indexOf("--jql") + 1]!;
  };

  it("reproduces current scan JQL for every queue/state pair", async () => {
    expect(await jqlFor("bugTodo", "todo")).toBe("project = PROJ AND labels = auto-fix AND status = 'To Do'");
    expect(await jqlFor("featureTodo", "todo")).toBe("project = PROJ AND labels = auto-feature AND status = 'To Do'");
    expect(await jqlFor("done", "todo")).toBe("project = PROJ AND labels = auto-fixed AND status = 'To Do'");
    expect(await jqlFor("escalate", "todo")).toBe("project = PROJ AND labels = needs-human AND status = 'To Do'");
    expect(await jqlFor("bugTodo", "inReview")).toBe("project = PROJ AND labels = auto-fix AND status = 'In Review'");
    expect(await jqlFor("featureTodo", "inReview")).toBe(
      "project = PROJ AND labels = auto-feature AND status = 'In Review'",
    );
    expect(await jqlFor("done", "inReview")).toBe("project = PROJ AND labels = auto-fixed AND status = 'In Review'");
    expect(await jqlFor("escalate", "inReview")).toBe(
      "project = PROJ AND labels = needs-human AND status = 'In Review'",
    );
  });

  it("calls acli with the expected search command", async () => {
    const { gateway, sim } = harness();
    await gateway.findCandidates({ queue: "bugTodo", state: "todo" });
    expect(sim.commands[0]).toEqual([
      "acli",
      "jira",
      "workitem",
      "search",
      "--jql",
      "project = PROJ AND labels = auto-fix AND status = 'To Do'",
      "--json",
    ]);
  });

  it("follows the project vocabulary: labels and statuses from config", async () => {
    const sim = createAcliSim();
    const gateway = createJiraWorkItemGateway({
      workItem: { provider: "jira", project: "OPS", todoState: "Backlog", reviewState: "Code Review" },
      labels: { bugTodo: "robot-bug", featureTodo: "robot-feat", done: "robot-ok", escalate: "human" },
      run: sim.run,
      adfConverter: NO_CONVERTER,
    });
    await gateway.findCandidates({ queue: "escalate", state: "inReview" });
    expect(sim.commands[0]?.[5]).toBe("project = OPS AND labels = human AND status = 'Code Review'");
  });
});

describe("jira gateway — parsing acli output", () => {
  const keysOf = async (stdout: string): Promise<string[]> => {
    const { gateway } = stubbed(ok(stdout));
    return gateway.findCandidates({ queue: "bugTodo", state: "todo" });
  };

  it("tableau plat", async () => {
    expect(await keysOf('[{"key":"PROJ-1"},{"key":"PROJ-2"}]')).toEqual(["PROJ-1", "PROJ-2"]);
  });

  it("enveloppe {issues:[…]}", async () => {
    expect(await keysOf('{"total":2,"issues":[{"key":"PROJ-7"},{"key":"PROJ-8"}]}')).toEqual(["PROJ-7", "PROJ-8"]);
  });

  it("nested objects, deduplication, and appearance order", async () => {
    const stdout = JSON.stringify({
      sections: [
        { items: [{ key: "PROJ-9", parent: { key: "PROJ-3" } }] },
        { items: [{ key: "PROJ-9" }, { key: "PROJ-4" }] },
      ],
    });
    expect(await keysOf(stdout)).toEqual(["PROJ-9", "PROJ-3", "PROJ-4"]);
  });

  it("ignores values that do not look like a Jira key", async () => {
    expect(await keysOf('[{"key":"proj-1"},{"key":"NOPE"},{"key":"PROJ-5"}]')).toEqual(["PROJ-5"]);
  });

  it("invalid JSON during search → no candidate (current scan behavior)", async () => {
    expect(await keysOf("Fetching issues...\n")).toEqual([]);
    expect(parseAcliTicketKeys("")).toEqual([]);
  });

  it("search failure → error containing acli output", async () => {
    const { gateway } = stubbed(ko("JQL error: field 'labels' does not exist"));
    const message = await messageOf(gateway.findCandidates({ queue: "bugTodo", state: "todo" }));
    expect(message).toContain("jira");
    expect(message).toContain("JQL error");
  });

  it("comments: human exchanges projected in order, pipeline notes removed", async () => {
    // This is the response channel for a `needs-info` escalation: the question is
    // posted as a comment and the response arrives there. Runner notes carry the
    // `[pipeline:…]` marker and must not become specification material.
    const payload = JSON.stringify({
      key: "PROJ-24",
      fields: {
        summary: "Titre",
        description: "Corps",
        comment: {
          comments: [
            { body: "Question du PO : quel comportement au quota ?" },
            { body: "Escalation — 1 open decision\n[pipeline:escalate-assumptions:PROJ-24]" },
            { body: "  Answer: explicit refusal with message.  " },
            { body: "   " },
          ],
        },
      },
    });
    const { gateway } = stubbed(ok(payload));
    const item = await gateway.fetch("PROJ-24");
    expect(item.comments).toEqual([
      "Question du PO : quel comportement au quota ?",
      "Answer: explicit refusal with message.",
    ]);
  });

  it("comments: ticket without exchanges → empty array, never undefined", async () => {
    const { gateway } = stubbed(ok('{"key":"PROJ-24","fields":{"summary":"T","description":"C"}}'));
    expect((await gateway.fetch("PROJ-24")).comments).toEqual([]);
  });

  it("view failure → error naming the reference and acli output", async () => {
    const { gateway } = stubbed(ko('Work item "PROJ-4242" does not exist'));
    const message = await messageOf(gateway.fetch("PROJ-4242"));
    expect(message).toContain("PROJ-4242");
    expect(message).toContain("does not exist");
  });

  it("invalid JSON output while reading → explicit error", async () => {
    const { gateway } = stubbed(ok("<html>proxy error</html>"));
    const message = await messageOf(gateway.fetch("PROJ-24"));
    expect(message).toContain("invalid JSON");
    expect(message).toContain("PROJ-24");
  });

  it("payload without fields block → explicit error", async () => {
    const { gateway } = stubbed(ok('{"key":"PROJ-24"}'));
    expect(await messageOf(gateway.fetch("PROJ-24"))).toContain("no readable fields");
  });

  it("nested or array fields block → tolerated", async () => {
    const nested = stubbed(ok('[{"key":"PROJ-24","fields":{"summary":"Titre","description":"Corps"}}]'));
    expect(await nested.gateway.fetch("PROJ-24")).toEqual({
      ref: "PROJ-24",
      title: "Titre",
      description: "Corps",
      closed: false,
      comments: [],
    });
  });
});

describe("jira gateway — reading a ticket", () => {
  it("read command: requested fields and positional reference", async () => {
    const { gateway, sim } = harness();
    await gateway.fetch("PROJ-24");
    // `status` is in the SAME view as the title and description: the "ticket
    // completed" guard requires no additional network round trip.
    expect(sim.commands[0]).toEqual([
      "acli",
      "jira",
      "workitem",
      "view",
      "PROJ-24",
      "--fields",
      "summary,description,status,comment",
      "--json",
    ]);
    expect(commandsMatching(sim, "view")).toHaveLength(1);
  });

  it("converts ADF to markdown (internal fallback)", async () => {
    const { gateway } = harness();
    const item = await gateway.fetch("PROJ-24");
    expect(item.title).toBe("500 error on export");
    expect(item.description).toBe("## Contexte\n\nL'export plante en prod.");
  });

  it("text description → kept as is", async () => {
    const { gateway } = harness([{ key: "PROJ-24", description: "Texte simple\n" }]);
    expect((await gateway.fetch("PROJ-24")).description).toBe("Texte simple");
  });

  it("missing title → error naming the reference", async () => {
    const { gateway } = stubbed(ok('{"key":"PROJ-24","fields":{"summary":"","description":"x"}}'));
    const message = await messageOf(gateway.fetch("PROJ-24"));
    expect(message).toContain("PROJ-24");
    expect(message).toContain("has no title");
  });

  it("empty description → error (the next step depends on this spec)", async () => {
    const { gateway } = harness([{ key: "PROJ-24", description: null }]);
    expect(await messageOf(gateway.fetch("PROJ-24"))).toContain("no usable description");
  });

  it("reuses the plugin script when available", async () => {
    const { gateway, sim } = harness(DEFAULT_SEED, FAKE_CONVERTER);
    sim.python = ok("## Contexte converti par le script\n");
    const item = await gateway.fetch("PROJ-24");
    expect(item.description).toBe("## Contexte converti par le script");
    const shell = sim.commands.find((command) => command[0] === "sh")!;
    expect(shell[1]).toBe("-c");
    // Paths are positional arguments ($1 = script, $2 = payload), so nothing is
    // interpolated into the shell script.
    expect(shell[4]).toBe(FAKE_CONVERTER);
    // The payload goes through a file because the process port does not expose stdin.
    expect(shell[5]).toContain("workitem.json");
  });

  it("script not found → internal conversion, no conversion subprocess", async () => {
    const { gateway, sim } = harness();
    await gateway.fetch("PROJ-24");
    expect(sim.commands.some((command) => command[0] === "sh")).toBe(false);
  });

  it("script present but fails (python missing) → internal conversion", async () => {
    const { gateway, sim } = harness(DEFAULT_SEED, FAKE_CONVERTER);
    sim.python = ko("sh: python3: command not found", 127);
    expect((await gateway.fetch("PROJ-24")).description).toBe("## Contexte\n\nL'export plante en prod.");
  });

  it("script present but output is empty → internal conversion", async () => {
    const { gateway, sim } = harness(DEFAULT_SEED, FAKE_CONVERTER);
    sim.python = ok("\n");
    expect((await gateway.fetch("PROJ-24")).description).toBe("## Contexte\n\nL'export plante en prod.");
  });
});

describe("jira gateway — completed ticket (closed projection)", () => {
  /** `closed` as the adapter projects it from a given `status` block. `undefined`
   *  means the response has no status field. */
  const closedFor = async (status: unknown): Promise<boolean> => {
    const fields: Record<string, unknown> = { summary: "Titre", description: "Corps" };
    if (status !== undefined) fields.status = status;
    const { gateway } = stubbed(ok(JSON.stringify({ key: "PROJ-24", fields })));
    return (await gateway.fetch("PROJ-24")).closed;
  };

  it("done category → completed, regardless of status name", async () => {
    // The name appears in NONE of the lists: only the category decides. This is
    // the point of this path, since status names vary between projects.
    expect(await closedFor({ name: "Terminado", statusCategory: { id: "3", key: "done" } })).toBe(true);
    expect(await closedFor({ name: "Won't Do", statusCategory: { key: "Done" } })).toBe(true);
    // ASSUMPTION: some outputs expose only the category label.
    expect(await closedFor({ name: "Entregado", statusCategory: { name: "Done" } })).toBe(true);
    // ASSUMPTION: others flatten it to a plain string, like the status itself.
    expect(await closedFor({ name: "Entregado", statusCategory: "done" })).toBe(true);
  });

  it("category other than done → open, even if the name resembles a terminal status", async () => {
    expect(await closedFor({ name: "To Do", statusCategory: { key: "new" } })).toBe(false);
    expect(await closedFor({ name: "In Review", statusCategory: { key: "indeterminate" } })).toBe(false);
    // The category takes precedence when readable: a status named "Done" but
    // classified as "in progress" still has work remaining.
    expect(await closedFor({ name: "Done", statusCategory: { key: "indeterminate" } })).toBe(false);
  });

  it("category absent → fall back to historical prompt status names", async () => {
    // ASSUMPTION: an `acli` response may omit `statusCategory` entirely.
    for (const name of ["Done", "Closed", "Cancelled", "done", "  CLOSED  "]) {
      expect(await closedFor({ name })).toBe(true);
    }
    // Status flattened to a plain string: same fallback.
    expect(await closedFor("Done")).toBe(true);
  });

  it("category absent and name outside the list → open", async () => {
    for (const name of ["To Do", "In Review", "Terminado", "Won't Do", ""]) {
      expect(await closedFor({ name })).toBe(false);
    }
  });

  it("no status field in response → open without failing", async () => {
    // A silent guard costs an unnecessary run; a guard that rejects everything when
    // `acli` changes shape blocks the entire pipeline. Choose the former.
    expect(await closedFor(undefined)).toBe(false);
    expect(await closedFor(null)).toBe(false);
    expect(await closedFor({})).toBe(false);
    expect(await closedFor({ statusCategory: {} })).toBe(false);
  });

  it("status read from simulator: open vs terminal ticket", async () => {
    const { gateway } = harness();
    expect((await gateway.fetch("PROJ-24")).closed).toBe(false);
    expect((await gateway.fetch("PROJ-26")).closed).toBe(true);
  });

  it("category lifted to fields level (flattened output) → considered", async () => {
    // ASSUMPTION: `--fields status` may return the category beside the status
    // rather than nested inside it.
    const { gateway } = stubbed(
      ok(
        JSON.stringify({
          key: "PROJ-24",
          fields: { summary: "T", description: "C", status: "Terminado", statusCategory: { key: "done" } },
        }),
      ),
    );
    expect((await gateway.fetch("PROJ-24")).closed).toBe(true);
  });
});

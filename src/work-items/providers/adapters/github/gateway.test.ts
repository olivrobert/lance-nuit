import { describe, expect, it } from "bun:test";
import { markerFor } from "../../../../contracts/work-items.js";
import { createGithubWorkItemGateway } from "./index.js";
import { commandsMatching, harness, ko, LABELS, messageOf, NOTE, ok, stubbed, WORK_ITEM } from "./test-harness.js";

describe("github gateway — identity and references", () => {
  it("uses GitHub issue numbers and the configured repository", () => {
    const { gateway } = harness();
    expect(gateway.provider).toBe("github");
    expect(gateway.validateRef("24")).toEqual({ ok: true });
    expect(gateway.validateRef("#24").ok).toBe(false);
    expect(gateway.validateRef("owner/repo#24").ok).toBe(false);
    expect(gateway.validateRef("PROJ-24").ok).toBe(false);
  });

  it("invalid reference launches no gh command", async () => {
    const { gateway, commands } = stubbed(ok("{}"));
    expect(await messageOf(gateway.fetch("nope"))).toContain("invalid");
    expect(await messageOf(gateway.moveTo("nope", { queue: "done" }))).toContain("invalid");
    expect(commands).toHaveLength(0);
  });

  it("requires a repository project", () => {
    expect(() => createGithubWorkItemGateway({ workItem: { ...WORK_ITEM, project: "" }, labels: LABELS })).toThrow(
      /project/,
    );
  });
});

describe("github gateway — fetch and scan", () => {
  it("reads title, body, state, labels and comments from gh JSON", async () => {
    const { gateway, sim } = harness([
      {
        number: 24,
        title: "Export fails",
        body: "Details",
        labels: ["queue:bug", "pipeline:todo"],
        comments: ["Human question", `Pipeline note <!-- ${markerFor({ ticket: "24", stepId: "old" })} -->`],
      },
    ]);
    const item = await gateway.fetch("24");
    expect(item).toEqual({
      ref: "24",
      title: "Export fails",
      description: "Details",
      closed: false,
      comments: ["Human question"],
    });
    expect(sim.commands[0]).toEqual([
      "gh",
      "issue",
      "view",
      "24",
      "--repo",
      "acme/lance-nuit",
      "--comments",
      "--json",
      "title,body,state,labels,comments,number",
    ]);
  });

  it("filters candidates with both queue and logical state labels", async () => {
    const { gateway, sim } = harness();
    expect(await gateway.findCandidates({ queue: "bugTodo", state: "todo" })).toEqual(["24"]);
    expect(sim.commands[0]).toEqual([
      "gh",
      "issue",
      "list",
      "--repo",
      "acme/lance-nuit",
      "--state",
      "open",
      "--label",
      "queue:bug",
      "--label",
      "pipeline:todo",
      "--limit",
      "1000",
      "--json",
      "number",
    ]);
  });

  it("does not return closed issues during a scan", async () => {
    const { gateway } = harness([
      {
        number: 26,
        title: "Closed",
        body: "Done",
        state: "CLOSED",
        labels: [LABELS.done, WORK_ITEM.todoState],
      },
    ]);
    expect(await gateway.findCandidates({ queue: "done", state: "todo" })).toEqual([]);
  });
});

describe("github gateway — comments", () => {
  it("publishes Markdown and deduplicates by execution marker", async () => {
    const { gateway, sim } = harness();
    const key = { ticket: "24", stepId: "escalate" };
    await gateway.comment("24", NOTE, key);
    await gateway.comment("24", NOTE, key);
    expect(commandsMatching(sim, "comment")).toHaveLength(1);
    expect(sim.issueOf(24)?.comments).toHaveLength(1);
    expect(sim.issueOf(24)?.comments[0]).toContain(`<!-- ${markerFor(key)} -->`);
  });

  it("keeps human comments while filtering pipeline comments from fetch", async () => {
    const key = { ticket: "24", stepId: "escalate" };
    const { gateway } = harness([{ number: 24, comments: [`human reply`, `<!-- ${markerFor(key)} -->`] }]);
    expect((await gateway.fetch("24")).comments).toEqual(["human reply"]);
  });
});

describe("github gateway — moves", () => {
  it("adds/removes queue and state labels in port order", async () => {
    const { gateway, sim } = harness();
    await gateway.moveTo("24", { queue: "done", from: "bugTodo", state: "inReview" });
    expect(sim.issueOf(24)?.labels).toEqual([LABELS.done, WORK_ITEM.reviewState]);
    expect(commandsMatching(sim, "edit").map((command) => command.slice(0, 8))).toEqual([
      ["gh", "issue", "edit", "24", "--repo", "acme/lance-nuit", "--add-label", LABELS.done],
      ["gh", "issue", "edit", "24", "--repo", "acme/lance-nuit", "--remove-label", LABELS.bugTodo],
      ["gh", "issue", "edit", "24", "--repo", "acme/lance-nuit", "--remove-label", WORK_ITEM.todoState],
      ["gh", "issue", "edit", "24", "--repo", "acme/lance-nuit", "--add-label", WORK_ITEM.reviewState],
    ]);
  });

  it("replays a partially applied move", async () => {
    const { gateway, sim } = harness();
    sim.armInterrupt(24, 1);
    await expect(gateway.moveTo("24", { queue: "done", from: "bugTodo", state: "inReview" })).rejects.toThrow();
    await gateway.moveTo("24", { queue: "done", from: "bugTodo", state: "inReview" });
    expect(sim.issueOf(24)?.labels).toEqual([LABELS.done, WORK_ITEM.reviewState]);
  });

  it("does not launch a command for an empty move", async () => {
    const { gateway, sim } = harness();
    await gateway.moveTo("24", {});
    expect(sim.commands).toHaveLength(0);
  });
});

describe("github gateway — diagnostics", () => {
  it("reports a missing gh executable", async () => {
    const { gateway } = stubbed(ko("spawn gh ENOENT", 127));
    const message = await messageOf(gateway.findCandidates({ queue: "bugTodo", state: "todo" }));
    expect(message).toMatch(/GitHub/i);
    expect(message).toContain("gh");
    expect(message).toMatch(/required/i);
  });

  it("propagates issue lookup errors with the reference", async () => {
    const { gateway } = stubbed(ko("Issue #9999 does not exist"));
    const message = await messageOf(gateway.fetch("9999"));
    expect(message).toContain("9999");
    expect(message).toContain("does not exist");
  });
});

describe("github gateway — pipeline-owned discovery", () => {
  it("forwards the query through --search and adds no state or label filter", async () => {
    const { gateway, sim } = harness();
    const query = "is:open assignee:ada label:bug";
    expect(await gateway.findCandidates({ queue: "bugTodo", state: "todo", query })).toEqual(["24", "25"]);
    expect(sim.commands[0]).toEqual([
      "gh",
      "issue",
      "list",
      "--repo",
      "acme/lance-nuit",
      "--search",
      query,
      "--limit",
      "1000",
      "--json",
      "number",
    ]);
  });
});

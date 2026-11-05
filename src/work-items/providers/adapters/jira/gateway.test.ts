import { describe, expect, it } from "bun:test";
import { markerFor, renderPlainText } from "../../../../contracts/work-items.js";
import { commandsMatching, harness, ko, messageOf, NOTE, ok, stubbed } from "./test-harness.js";

describe("jira gateway — identity and references", () => {
  it("provider and reference format", () => {
    const { gateway } = harness();
    expect(gateway.provider).toBe("jira");
    expect(gateway.validateRef("PROJ-24")).toEqual({ ok: true });
    expect(gateway.validateRef("AB1-9").ok).toBe(true);
    expect(gateway.validateRef("proj-24").ok).toBe(false);
    expect(gateway.validateRef("PROJ24").ok).toBe(false);
    expect(gateway.validateRef("1284").ok).toBe(false);
    expect(gateway.validateRef("").ok).toBe(false);
  });

  it("rejection cites the expected format", () => {
    const { gateway } = harness();
    const result = gateway.validateRef("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("nope");
      expect(result.reason).toContain("PROJ-123");
    }
  });

  it("invalid reference → no acli command launched", async () => {
    const { gateway, commands } = stubbed(ok("{}"));
    expect(await messageOf(gateway.fetch("nope"))).toContain("invalid");
    expect(await messageOf(gateway.moveTo("nope", { queue: "done" }))).toContain("invalid");
    expect(commands).toHaveLength(0);
  });
});

describe("jira gateway — comments", () => {
  it("publishes plain text with the expected acli command", async () => {
    const { gateway, sim } = harness();
    const key = { ticket: "PROJ-24", stepId: "escalate" };
    await gateway.comment("PROJ-24", NOTE, key);
    const create = sim.commands.find((command) => command[3] === "comment")!;
    expect(create.slice(0, 6)).toEqual(["acli", "jira", "workitem", "comment", "create", "--key"]);
    expect(create[6]).toBe("PROJ-24");
    expect(create[7]).toBe("--body");
    expect(create[8]).toBe(renderPlainText(NOTE, key));
    expect(create[8]).not.toContain("**");
  });

  it("reads ticket comments before writing", async () => {
    const { gateway, sim } = harness();
    await gateway.comment("PROJ-24", NOTE, { ticket: "PROJ-24", stepId: "escalate" });
    expect(sim.commands[0]).toEqual(["acli", "jira", "workitem", "view", "PROJ-24", "--fields", "comment", "--json"]);
  });

  it("marker already present in Jira (rendered ADF body) → no write", async () => {
    const key = { ticket: "PROJ-24", stepId: "escalate" };
    const { gateway, sim } = harness([
      { key: "PROJ-24", comments: [`Note posted before the crash\n${markerFor(key)}`] },
    ]);
    await gateway.comment("PROJ-24", NOTE, key);
    expect(commandsMatching(sim, "comment")).toHaveLength(0);
    expect(sim.ticketOf("PROJ-24")?.comments).toHaveLength(1);
  });

  it("human comment without marker → still writes", async () => {
    const { gateway, sim } = harness([{ key: "PROJ-24", comments: ["Je regarde ce ticket demain."] }]);
    await gateway.comment("PROJ-24", NOTE, { ticket: "PROJ-24", stepId: "escalate" });
    expect(sim.ticketOf("PROJ-24")?.comments).toHaveLength(2);
  });

  it("unable to read comments → no blind write", async () => {
    const { gateway, commands } = stubbed((_cmd, args) =>
      args[2] === "view" ? ko("503 Service Unavailable") : ok("{}"),
    );
    const message = await messageOf(gateway.comment("PROJ-24", NOTE, { ticket: "PROJ-24", stepId: "escalate" }));
    expect(message).toContain("PROJ-24");
    expect(commands.some((command) => command[3] === "comment")).toBe(false);
  });

  it("publication failure → error propagated", async () => {
    const { gateway } = stubbed((_cmd, args) =>
      args[2] === "view" ? ok('{"key":"PROJ-24","fields":{"comment":{"comments":[]}}}') : ko("permission denied"),
    );
    const message = await messageOf(gateway.comment("PROJ-24", NOTE, { ticket: "PROJ-24", stepId: "escalate" }));
    expect(message).toContain("permission denied");
  });

  it("plain-text body in acli output → marker detected too", async () => {
    const key = { ticket: "PROJ-24", stepId: "jira-update" };
    const { gateway, commands } = stubbed(
      ok(
        JSON.stringify({
          key: "PROJ-24",
          fields: { comment: { comments: [{ body: `MR ouverte. ${markerFor(key)}` }] } },
        }),
      ),
    );
    await gateway.comment("PROJ-24", NOTE, key);
    expect(commands.some((command) => command[3] === "comment")).toBe(false);
  });
});

describe("jira gateway — moves", () => {
  it("moves the ticket in three commands, in port order", async () => {
    const { gateway, sim } = harness();
    await gateway.moveTo("PROJ-24", { queue: "done", from: "bugTodo", state: "inReview" });
    const writes = sim.commands.filter((command) => command[3] === "edit" || command[3] === "transition");
    expect(writes).toEqual([
      ["acli", "jira", "workitem", "edit", "--key", "PROJ-24", "--labels", "auto-fixed", "--yes"],
      ["acli", "jira", "workitem", "edit", "--key", "PROJ-24", "--remove-labels", "auto-fix", "--yes"],
      ["acli", "jira", "workitem", "transition", "--key", "PROJ-24", "--status", "In Review", "--yes"],
    ]);
    expect(sim.ticketOf("PROJ-24")?.labels).toEqual(["auto-fixed"]);
    expect(sim.ticketOf("PROJ-24")?.status).toBe("In Review");
  });

  it("reads state only once per move", async () => {
    const { gateway, sim } = harness();
    await gateway.moveTo("PROJ-24", { queue: "escalate", from: "bugTodo" });
    expect(commandsMatching(sim, "view")).toHaveLength(1);
    expect(sim.commands[0]).toEqual([
      "acli",
      "jira",
      "workitem",
      "view",
      "PROJ-24",
      "--fields",
      "labels,status",
      "--json",
    ]);
  });

  it("source label absent → no removal command, success", async () => {
    const { gateway, sim } = harness();
    await gateway.moveTo("PROJ-24", { queue: "escalate", from: "done" });
    expect(sim.commands.filter((command) => command.includes("--remove-labels"))).toHaveLength(0);
    expect(sim.ticketOf("PROJ-24")?.labels).toEqual(["auto-fix", "needs-human"]);
  });

  it("target label already present → no add command", async () => {
    const { gateway, sim } = harness();
    await gateway.moveTo("PROJ-24", { queue: "bugTodo" });
    expect(sim.commands.filter((command) => command.includes("--labels"))).toHaveLength(0);
  });

  it("status already reached → no transition launched", async () => {
    const { gateway, sim } = harness();
    await gateway.moveTo("PROJ-24", { state: "todo" });
    expect(commandsMatching(sim, "transition")).toHaveLength(0);
  });

  it("empty move → no command at all", async () => {
    const { gateway, sim } = harness();
    await gateway.moveTo("PROJ-24", {});
    expect(sim.commands).toHaveLength(0);
  });

  it("transition refused but status already matches → success (resume)", async () => {
    // `acli` rejects the transition, but rereading shows the target state was
    // already reached: the initial snapshot was stale, not the result.
    let views = 0;
    const { gateway } = stubbed((_cmd, args) => {
      if (args[2] === "view") {
        views += 1;
        return ok(
          JSON.stringify({
            key: "PROJ-24",
            fields: { labels: [], status: { name: views === 1 ? "To Do" : "In Review" } },
          }),
        );
      }
      return ko('No transition to "In Review" available');
    });
    await gateway.moveTo("PROJ-24", { state: "inReview" });
    expect(views).toBe(2);
  });

  it("transition fails and status unchanged → error", async () => {
    const { gateway } = stubbed((_cmd, args) =>
      args[2] === "view"
        ? ok('{"key":"PROJ-24","fields":{"labels":[],"status":{"name":"To Do"}}}')
        : ko("workflow rejected"),
    );
    const message = await messageOf(gateway.moveTo("PROJ-24", { state: "inReview" }));
    expect(message).toContain("In Review");
    expect(message).toContain("workflow rejected");
  });

  it("removal fails but label already gone → success", async () => {
    let views = 0;
    const { gateway } = stubbed((_cmd, args) => {
      if (args[2] === "view") {
        views += 1;
        return ok(
          JSON.stringify({
            key: "PROJ-24",
            fields: { labels: views === 1 ? ["auto-fix"] : [], status: { name: "To Do" } },
          }),
        );
      }
      return ko("edit failed");
    });
    await gateway.moveTo("PROJ-24", { from: "bugTodo" });
    expect(views).toBe(2);
  });

  it("removal fails with label still present → error", async () => {
    const { gateway } = stubbed((_cmd, args) =>
      args[2] === "view"
        ? ok('{"key":"PROJ-24","fields":{"labels":["auto-fix"],"status":{"name":"To Do"}}}')
        : ko("edit failed"),
    );
    const message = await messageOf(gateway.moveTo("PROJ-24", { from: "bugTodo" }));
    expect(message).toContain("auto-fix");
    expect(message).toContain("edit failed");
  });

  it("adding label fails → error, move stops before the next step", async () => {
    const { gateway, commands } = stubbed((_cmd, args) =>
      args[2] === "view"
        ? ok('{"key":"PROJ-24","fields":{"labels":["auto-fix"],"status":{"name":"To Do"}}}')
        : ko("field 'labels' is read-only"),
    );
    const message = await messageOf(
      gateway.moveTo("PROJ-24", { queue: "escalate", from: "bugTodo", state: "inReview" }),
    );
    expect(message).toContain("needs-human");
    expect(commands.filter((command) => command[3] === "transition")).toHaveLength(0);
  });

  it("status read as a plain string → comparison still works", async () => {
    const { gateway, commands } = stubbed(ok('{"key":"PROJ-24","fields":{"labels":[],"status":"in review"}}'));
    await gateway.moveTo("PROJ-24", { state: "inReview" });
    expect(commands.filter((command) => command[3] === "transition")).toHaveLength(0);
  });
});

describe("jira gateway — discovery", () => {
  it("projects queue and state onto the default JQL", async () => {
    const { gateway, sim } = harness();
    expect(await gateway.findCandidates({ queue: "bugTodo", state: "todo" })).toEqual(["PROJ-24"]);
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

  it("sends a pipeline-owned query verbatim, without projecting queue or state", async () => {
    const query = "project = PROJ AND status = 'To Do' AND assignee = 'Ada Lovelace'";
    const { gateway, sim } = harness([
      { key: "PROJ-30", assignee: "Ada Lovelace" },
      { key: "PROJ-31", assignee: "Ada Lovelace", labels: ["auto-fix"] },
      { key: "PROJ-32", assignee: "Grace Hopper" },
      { key: "PROJ-33", assignee: "Ada Lovelace", status: "In Review" },
    ]);
    expect(await gateway.findCandidates({ queue: "bugTodo", state: "todo", query })).toEqual(["PROJ-30", "PROJ-31"]);
    expect(sim.commands[0]).toEqual(["acli", "jira", "workitem", "search", "--jql", query, "--json"]);
  });
});

// Consumer tests for the reusable WorkItemGateway conformance API.
import { describe, expect, it } from "bun:test";
import { createWorkItemGatewayContract, type WorkItemGatewayContractOptions } from "../../contracts/testing.js";
import type { ExecutionKey, WorkItemNote } from "../../contracts/work-items.js";
import { hasMarker, markerFor, renderMarkdown, renderPlainText } from "../../contracts/work-items.js";
import { createFakeWorkItemGateway, type FakeWorkItemGateway } from "./fake.js";

const runWorkItemGatewayContract = createWorkItemGatewayContract({ describe, it, expect });

const SAMPLE_NOTE: WorkItemNote = {
  headline: "🤖 Pipeline bugfix: automatic escalation.",
  fields: [
    { label: "Reason", value: "**Not reproducible** locally, see `src/Foo.php`." },
    { label: "Details", value: "Proposal in [refactoring-proposal](docs/refactoring-proposal.md)." },
  ],
  footer: "Human review required before any fix.",
};

const fakeFactory =
  (rendering: "plain" | "markdown" = "plain") =>
  (): FakeWorkItemGateway =>
    createFakeWorkItemGateway({
      rendering,
      items: [
        {
          ref: "PROJ-24",
          title: "500 error on export",
          description: "## Contexte\nL'export plante.",
          queues: ["bugTodo"],
          state: "todo",
        },
        {
          ref: "PROJ-25",
          title: "Filtrer la liste",
          description: "Ajouter un filtre.",
          queues: ["featureTodo"],
          state: "todo",
        },
        { ref: "PROJ-26", title: "Export already delivered", description: "Delivered in June.", closed: true },
      ],
    });

const fakeOptions = (rendering: "plain" | "markdown"): WorkItemGatewayContractOptions => ({
  rendering,
  readNotes: (gateway, ref) => (gateway as FakeWorkItemGateway).bodiesOf(ref),
  armMoveInterrupt: (gateway, ref, afterOps) =>
    (gateway as FakeWorkItemGateway).armFailure({ op: "moveTo", ref, afterOps }),
  appliedOperations: (gateway) => (gateway as FakeWorkItemGateway).ops,
});

runWorkItemGatewayContract("fake (plain rendering)", fakeFactory("plain"), fakeOptions("plain"));
runWorkItemGatewayContract("fake (markdown rendering)", fakeFactory("markdown"), fakeOptions("markdown"));

describe("fake work-item gateway failure handling", () => {
  it("gateway rejects invalid transitions", () => {
    const gateway = createFakeWorkItemGateway();
    expect(gateway.validateRef("PROJ-24").ok).toBe(true);
    expect(gateway.validateRef("1284").ok).toBe(true);
    expect(gateway.validateRef("PROJ").ok).toBe(false);
    expect(gateway.validateRef("").ok).toBe(false);
  });

  it("fetch retries successfully after a transient timeout", async () => {
    const gateway = fakeFactory()();
    gateway.armFailure({ op: "fetch", ref: "PROJ-24", kind: "timeout" });
    await expect(gateway.fetch("PROJ-24")).rejects.toThrow(/timeout/);
    expect((await gateway.fetch("PROJ-24")).ref).toBe("PROJ-24");
  });

  it("comment can be retried after a transient provider error", async () => {
    const gateway = fakeFactory()();
    gateway.armFailure({ op: "comment", kind: "error" });
    await expect(gateway.comment("PROJ-24", SAMPLE_NOTE, { ticket: "PROJ-24", stepId: "escalate" })).rejects.toThrow();
    await gateway.comment("PROJ-24", SAMPLE_NOTE, { ticket: "PROJ-24", stepId: "escalate" });
    expect(gateway.calls.map((call) => call.op)).toEqual(["comment", "comment"]);
    expect(gateway.notes).toHaveLength(1);
  });

  it("moveTo applies queue and state changes", async () => {
    const gateway = fakeFactory()();
    await gateway.moveTo("PROJ-24", { queue: "done", from: "bugTodo", state: "inReview" });
    expect(gateway.queuesOf("PROJ-24")).toEqual(["done"]);
    expect(gateway.stateOf("PROJ-24")).toBe("inReview");
  });
});

describe("note rendering and markers", () => {
  const key: ExecutionKey = { ticket: "PROJ-24", stepId: "escalate" };

  it("markerFor normalizes execution keys deterministically", () => {
    expect(markerFor(key)).toBe("[pipeline:escalate:PROJ-24]");
    expect(markerFor({ ticket: "PROJ 24", stepId: "escalate reuse" })).toBe("[pipeline:escalate-reuse:PROJ-24]");
    expect(markerFor(key)).toBe(markerFor({ ...key }));
  });

  it("renderPlainText emits fields and a trailing marker", () => {
    const lines = renderPlainText(SAMPLE_NOTE, key).split("\n");
    expect(lines[0]).toBe("🤖 Pipeline bugfix: automatic escalation.");
    expect(lines[2]).toContain("Reason : ");
    expect(lines.at(-1)).toBe(markerFor(key));
  });

  it("renderPlainText keeps the line structure of a multi-line field", () => {
    const value = "AC-1 :\n- First decision\n- Second decision\n\nAC-2 :\n- Other decision";
    const body = renderPlainText({ headline: "Assumptions", fields: [{ label: "Per criterion", value }] }, key);
    expect(body).toContain("Per criterion :\nAC-1 :\n- First decision\n- Second decision\n\nAC-2 :");
    expect(body).not.toContain("First decision - Second");
  });

  it("renderPlainText strips markdown syntax from note values", () => {
    const body = renderPlainText(
      { headline: "# Title", fields: [{ label: "Violations", value: "- `Foo` **duplicated**\n- see [here](x.md)" }] },
      key,
    );
    expect(body).toContain("Title");
    expect(body).toContain("- Foo duplicated");
    expect(body).toContain("- see here x.md");
    expect(body.split(markerFor(key)).join("")).not.toMatch(/[*`#]|\]\(/);
  });

  it("renderMarkdown formats fields and hides the marker in HTML", () => {
    const body = renderMarkdown(SAMPLE_NOTE, key);
    expect(body).toContain("**🤖 Pipeline bugfix: automatic escalation.**");
    expect(body).toContain("- **Reason** :");
    expect(body).toContain(`<!-- ${markerFor(key)} -->`);
  });

  it("hasMarker distinguishes matching and unrelated markers", () => {
    const other: ExecutionKey = { ticket: "PROJ-24", stepId: "work-item-update" };
    for (const body of [renderPlainText(SAMPLE_NOTE, key), renderMarkdown(SAMPLE_NOTE, key)]) {
      expect(hasMarker(body, key)).toBe(true);
      expect(hasMarker(body, other)).toBe(false);
    }
    expect(hasMarker("commentaire humain sans marqueur", key)).toBe(false);
  });
});

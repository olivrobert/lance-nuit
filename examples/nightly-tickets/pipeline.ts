import type { Dsl } from "@lance-nuit/dsl";

export default ({
  pipeline,
  bashStep,
  llmStep,
  artifact,
  textArtifact,
  source,
  mechanicalFix,
  workItemEscalateStep,
}: Dsl) => {
  const ticket = textArtifact("ticket.md");
  const implementation = textArtifact("implementation.md");
  // Read by review only: commit, which runs before it, moves HEAD.
  const head = source("head", { command: "git rev-parse HEAD" });
  const verdict = artifact("review.json", (raw) => {
    const value = raw as { verdict?: unknown; reason?: unknown };
    if (value.verdict !== "ship" && value.verdict !== "human") throw new Error("invalid verdict");
    return { verdict: value.verdict, reason: String(value.reason ?? "") };
  });

  return pipeline("nightly")
    .desc("Implement, test, commit, review, or hand over to a human")
    .forEachWorkItem({
      queue: "featureTodo",
      scan: { limit: 3 },
      maxCostPerWorkItemUsd: 8,
      do: [
        bashStep({
          id: "branch",
          name: "Create branch",
          // Idempotent, so it runs again on a resume and puts HEAD back on the branch.
          command: (ctx) => `git switch feat/${ctx.ticket} 2>/dev/null || git switch -c feat/${ctx.ticket}`,
          rerunOnResume: true,
        }),
        llmStep({
          id: "implement",
          name: "Implement",
          backend: "claude",
          profile: "coder",
          command: (ctx) =>
            `Implement ${ctx.ticket}. The ticket is in ${ctx.paths.artifact("ticket.md")}. ` +
            `Summarize what you changed in ${ctx.paths.artifact("implementation.md")}.`,
          // A human answer on the ticket changes ticket.md (pipeline notes are left out of it),
          // so the step implements again; otherwise its summary spares a resume the work.
          input: [ticket],
          output: [implementation],
          onFail: {
            fix: (ctx) => `The step failed. Fix the cause.\n\n${ctx.errors}`,
            retries: 2,
            escalate: { effort: "high", after: 1 },
          },
        }),
        bashStep({
          id: "test",
          name: "Run tests",
          command: "npm test",
          rerunOnResume: true,
          onFail: mechanicalFix(
            (ctx) => `The test suite failed. Fix the cause and change nothing else.\n\n${ctx.errors}`,
          ),
        }),
        bashStep({
          id: "commit",
          name: "Commit",
          command: (ctx) => `git add -A && { git diff --cached --quiet || git commit -m "${ctx.ticket}: implement"; }`,
          rerunOnResume: true,
        }),
        llmStep({
          id: "review",
          name: "Review",
          backend: "codex",
          profile: "reviewer",
          // Codex runs read-only by default: the step writes its verdict file, so
          // it needs the workspace.
          options: { sandbox: "workspace-write" },
          command: (ctx) =>
            `Review this branch against ${ctx.config.baseBranch}. ` +
            `Write {"verdict":"ship"|"human","reason":"..."} to ${ctx.paths.artifact("review.json")}.`,
          // A branch a human changed is reviewed again, so hand-over does not repeat a stale verdict.
          input: [head, implementation],
          output: [verdict],
        }),
        workItemEscalateStep({
          id: "hand-over",
          name: "Hand over to a human",
          artifact: verdict,
          onlyIf: (review) => review.verdict === "human",
          escalation: (review, ctx) => ({
            cause: review.reason,
            state: `committed on feat/${ctx.ticket}, not pushed`,
            action: "review the branch, then return the ticket to the queue",
          }),
        }),
      ],
    })
    .build();
};

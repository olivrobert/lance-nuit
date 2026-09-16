import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, bashStep, llmStep, artifact, mechanicalFix, workItemEscalateStep }: Dsl) => {
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
          command: (ctx) => `git switch -c feat/${ctx.ticket}`,
        }),
        llmStep({
          id: "implement",
          name: "Implement",
          backend: "claude",
          profile: "coder",
          command: (ctx) => `Implement ${ctx.ticket}. The ticket is in ${ctx.paths.artifact("ticket.md")}.`,
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
          onFail: mechanicalFix(
            (ctx) => `The test suite failed. Fix the cause and change nothing else.\n\n${ctx.errors}`,
          ),
        }),
        bashStep({
          id: "commit",
          name: "Commit",
          command: (ctx) => `git add -A && git commit -m "${ctx.ticket}: implement"`,
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

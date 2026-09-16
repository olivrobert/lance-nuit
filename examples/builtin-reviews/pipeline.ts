import type { Dsl, PipelineContext } from "@lance-nuit/dsl";

/**
 * Reference translation of the shipped contract examples into ordinary DSL
 * steps. The five steps below are the only executable entries in the current
 * builtin YAML files: four from `reviews.yml`, followed by the one from
 * `finalize.yml`. The `checks`, `gate`, and `preflight` builtin files are
 * intentionally empty extension points and therefore produce no steps.
 *
 * Keep paths explicit here. This is deliberately an authoring example, not a
 * compatibility helper: projects should copy the steps they need and adjust
 * their prompts, reports, and policies in TypeScript.
 */
export default ({ pipeline, llmStep }: Dsl) => {
  const reports = (ctx: PipelineContext) => ctx.paths.reportsDir ?? ctx.paths.workItemDir ?? "reports";
  const artifacts = (ctx: PipelineContext) => ctx.paths.artifactsDir ?? ctx.paths.workItemDir ?? "artifacts";

  return pipeline("builtin-reviews")
    .desc("Reference TypeScript translation of the shipped review steps")
    .add(
      llmStep({
        id: "review.acceptance-criteria",
        name: "Acceptance Criteria",
        backend: "claude",
        profile: "reviewer",
        options: { strictMcp: true },
        command: (ctx) =>
          `/quality-verifying-acceptance-criteria ${artifacts(ctx)}/spec.md reports=${reports(ctx)}/acceptance ui-checks=${artifacts(ctx)}/ui-checks.md screenshots=${reports(ctx)}/screenshots lot=${ctx.lot?.id ?? ""} lots=${artifacts(ctx)}/lots.json`,
        blocking: true,
        require: (ctx) => {
          const spec = artifacts(ctx);
          const appUrl = ctx.config.appUrl ?? "";
          return `test ! -f "${spec}/ui-checks.md" || test -z "${appUrl}" || curl -ksS -o /dev/null --max-time 5 "${appUrl}"`;
        },
      }),
      llmStep({
        id: "review.constraints",
        name: "Constraints",
        backend: "claude",
        profile: "reviewer",
        options: { strictMcp: true },
        command: (ctx) =>
          `/quality-constraints:quality-constraints-verify --ticket=${ctx.ticketDir ?? ""} --reports=${reports(ctx)}/constraints`,
        blocking: true,
      }),
      llmStep({
        id: "review.reuse-audit",
        name: "Reuse Audit",
        backend: "claude",
        profile: "reviewer",
        options: { strictMcp: true },
        command: (ctx) => `/reuse-audit --diff --ticket=${ctx.ticketDir ?? ""}`,
        blocking: true,
        when: { command: (ctx) => `test -f "${artifacts(ctx)}/reuse-watch.md"` },
      }),
      llmStep({
        id: "review.e2e-testing",
        name: "E2E Testing",
        backend: "claude",
        profile: "reviewer",
        options: { strictMcp: true, agent: "pipeline-e2e:qa-browser-tester" },
        command: (ctx) =>
          `Run every E2E scenario found in "${artifacts(ctx)}/e2e-scenarios.md" and write reports under "${reports(ctx)}/e2e/"`,
        blocking: true,
        when: { command: (ctx) => `test -f "${artifacts(ctx)}/e2e-scenarios.md"` },
        require: (ctx) => {
          const appUrl = ctx.config.appUrl ?? "";
          return `test -z "${appUrl}" || curl -ksS -o /dev/null --max-time 5 "${appUrl}"`;
        },
      }),
      llmStep({
        id: "finalize.quality-retrospective",
        name: "Quality Retrospective",
        backend: "claude",
        profile: "reviewer",
        options: { strictMcp: true },
        command: (ctx) => `/quality-constraints:quality-retrospective ${ctx.ticketDir ?? ""}`,
        blocking: false,
      }),
    )
    .build();
};

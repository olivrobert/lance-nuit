import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, bashStep }: Dsl) =>
  pipeline("jira-acli")
    .desc("Optional Jira work-item loading through acli")
    .forEachWorkItem({
      queue: "featureTodo",
      do: [
        bashStep({
          id: "process",
          name: "Process the loaded Jira work item",
          command: (ctx) => `printf 'loaded Jira work item %s\\n' '${ctx.ticket ?? "unknown"}'`,
        }),
      ],
    })
    .build();

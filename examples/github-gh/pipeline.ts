import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, bashStep }: Dsl) =>
  pipeline("github-gh")
    .desc("Optional GitHub Issues work-item loading through gh")
    .forEachWorkItem({
      queue: "featureTodo",
      do: [
        bashStep({
          id: "process",
          name: "Process the loaded GitHub issue",
          command: (ctx) => `printf 'loaded GitHub issue %s\\n' '${ctx.ticket ?? "unknown"}'`,
        }),
      ],
    })
    .build();

import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, bashStep }: Dsl) =>
  pipeline("generic-shell")
    .desc("A technology-neutral shell pipeline")
    .add(bashStep({ id: "hello", name: "Run a project command", command: "printf 'hello from a generic pipeline\\n'" }))
    .build();

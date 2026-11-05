import type { Dsl } from "../dsl.js";

/** A language-, tracker-, forge-, container-, and agent-neutral default. */
export default ({ pipeline, bashStep }: Dsl) =>
  pipeline("default")
    .desc("Generic standalone pipeline")
    .add(bashStep({ id: "ready", name: "Standalone runner ready", command: "printf 'lance-nuit ready\\n'" }))
    .build();

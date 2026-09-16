import type { Artifact } from "../../dsl/artifact.js";
import type { Dsl } from "../../dsl.js";
import type { ProjectEscalationStepOptions } from "./public-work-item.js";

interface Triage {
  verdict: "escalate" | "proceed";
  reason: string;
}

const triageArtifact = {} as Artifact<Triage>;

const simple: ProjectEscalationStepOptions<Triage> = {
  artifact: triageArtifact,
  escalation: (triage) => ({
    cause: triage.reason,
    state: "no code written",
    action: "complete the specification",
  }),
};

const advanced: ProjectEscalationStepOptions<Triage> = {
  artifact: triageArtifact,
  note: (triage) => ({ headline: triage.reason, fields: [] }),
};

// @ts-expect-error escalation and note are mutually exclusive.
const both: ProjectEscalationStepOptions<Triage> = {
  artifact: triageArtifact,
  escalation: () => ({ cause: "cause", state: "state", action: "action" }),
  note: () => ({ headline: "note", fields: [] }),
};

// @ts-expect-error exactly one note form is required.
const neither: ProjectEscalationStepOptions<Triage> = {
  artifact: triageArtifact,
};

const missingRequiredFields: ProjectEscalationStepOptions<Triage> = {
  artifact: triageArtifact,
  // @ts-expect-error cause, state, and action are required in the simple form.
  escalation: () => ({ cause: "cause", state: "state" }),
};

// Also verify the actual surface injected into project pipelines without executing
// values intended only for the compilation test.
// biome-ignore lint/correctness/noConstantCondition: compile-only block, never executed
if (false) {
  const dsl = {} as Dsl;
  dsl.workItemEscalateStep({
    artifact: triageArtifact,
    onlyIf: (triage) => triage.verdict === "escalate",
    escalation: (triage) => ({
      cause: triage.reason,
      state: "no code written",
      action: "complete the specification",
    }),
  });
  dsl.workItemEscalateStep(simple);
  dsl.workItemEscalateStep(advanced);
}

void both;
void neither;
void missingRequiredFields;

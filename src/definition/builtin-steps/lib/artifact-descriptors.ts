import { artifact, textArtifact } from "../../dsl/artifact.js";
import {
  parseAssumptionsArtifact,
  parseInputsArtifact,
  parseRedtestArtifact,
  parseReuseArtifact,
  parseTriageArtifact,
} from "./artifact-parsers.js";
import { parseLotsArtifact, parsePlanAuditArtifact } from "./artifact-plan-parsers.js";

export { blocksLots } from "./artifact-plan-parsers.js";

export const triageArtifact = artifact("triage.json", parseTriageArtifact);
export const redtestArtifact = artifact("redtest.json", parseRedtestArtifact);
export const reuseArtifact = artifact("reuse.json", parseReuseArtifact);
export const assumptionsArtifact = artifact("assumptions.json", parseAssumptionsArtifact);
export const inputsArtifact = artifact("inputs.json", parseInputsArtifact);
export const lotsArtifact = artifact("lots.json", parseLotsArtifact);
export const planAuditArtifact = artifact("plan-audit.json", parsePlanAuditArtifact);

function nonEmptyMarkdown(name: string): (raw: string) => string {
  return (raw: string): string => {
    if (!raw.trim()) throw new Error(`${name}: empty file`);
    return raw;
  };
}

export const specArtifact = textArtifact("spec.md", nonEmptyMarkdown("spec.md"));
export const planArtifact = textArtifact("plan.md", nonEmptyMarkdown("plan.md"));

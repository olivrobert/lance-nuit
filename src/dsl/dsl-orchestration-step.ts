import type { PipelineOrchestrationDefinition } from "../model/definition.js";
import { StepBuilder } from "./dsl-steps.js";

/** Internal/public builder for an orchestration node; it has no shell command. */
export class PipelineOrchestrationStepBuilder extends StepBuilder {
  constructor(id: string, name: string, orchestration: PipelineOrchestrationDefinition) {
    super(id, name, "pipeline");
    this.step.orchestration = orchestration;
  }
}

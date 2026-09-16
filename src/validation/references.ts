import { configFileLabel } from "../env/kit-paths.js";
import { listAvailableExtractors } from "../extractors/registry.js";
import { isStepProfileName } from "../model/profiles.js";
import { checkOverrideKeyShapes, checkStepOverrides } from "./step-overrides.js";
import { pipelineSteps } from "./structure.js";
import {
  backendRegistryOf,
  type PipelineValidationContext,
  type PipelineValidationFinding,
  type PipelineValidationRule,
} from "./types.js";

export { listAvailableExtractors };

/** References to extractor modules and report/extractor coupling. */
export class ExtractorReferenceValidator implements PipelineValidationRule {
  readonly id = "extractor-references";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const findings: PipelineValidationFinding[] = [];
    const available = context.availableExtractors ?? listAvailableExtractors();

    for (const step of pipelineSteps(context)) {
      if (step.error_extractor && !available.has(step.error_extractor)) {
        findings.push({
          rule: this.id,
          level: "error",
          message:
            `step "${step.id}": error_extractor "${step.error_extractor}" not found ` +
            `(available: ${[...available].join(", ") || "none"})`,
        });
      }
      if (step.report_paths?.length && !step.error_extractor) {
        findings.push({
          rule: this.id,
          level: "error",
          message: `step "${step.id}": report requires errorExtractor`,
        });
      }
    }

    return findings;
  }
}

function configMessage(source: string, message: string): string {
  return `Invalid configuration (${source}): ${message}`;
}

/** Profile/step references and configuration conflicts detectable before mutation. */
export class ConfigurationReferenceValidator implements PipelineValidationRule {
  readonly id = "configuration-references";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const findings: PipelineValidationFinding[] = [];
    const registry = backendRegistryOf(context);
    const profileOverrides = context.profileOverrides ?? {};
    const source = context.stepOverrideSource ?? configFileLabel(context.pipelineContext?.cwd);

    for (const [profile, configured] of Object.entries(profileOverrides)) {
      if (!isStepProfileName(profile)) {
        findings.push({
          rule: this.id,
          level: "error",
          message: configMessage(source, `profiles["${profile}"]: unknown profile`),
        });
        continue;
      }
      for (const backendId of Object.keys(configured?.backends ?? {})) {
        if (registry.has(backendId)) continue;
        findings.push({
          rule: this.id,
          level: "error",
          message: configMessage(
            source,
            `profiles["${profile}"].backends.${backendId}: unknown backend "${backendId}" ` +
              `(known: ${registry.known().join(", ") || "none"})`,
          ),
        });
      }
    }

    // Step-key rules live in step-overrides.ts, shared with the loader that applies
    // them and with `--lint-config`. Three copies had drifted apart in wording and
    // in coverage; this validator now only frames what they report.
    const overrides = context.stepOverrides ?? {};
    const stepFindings = [
      ...checkOverrideKeyShapes(overrides),
      ...checkStepOverrides({
        pipelineName: context.pipeline.name,
        steps: pipelineSteps(context),
        overrides,
        registry,
        context: context.pipelineContext,
      }),
    ];
    for (const finding of stepFindings) {
      findings.push({ rule: this.id, level: "error", message: configMessage(source, finding.message) });
    }

    return findings;
  }
}

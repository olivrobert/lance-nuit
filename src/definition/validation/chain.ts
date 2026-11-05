import type { PipelineValidationContext, PipelineValidationFinding, PipelineValidationRule } from "./types.js";

export class PipelineValidationReport {
  readonly findings: readonly PipelineValidationFinding[];

  constructor(findings: readonly PipelineValidationFinding[]) {
    this.findings = findings;
  }

  get errors(): readonly PipelineValidationFinding[] {
    return this.findings.filter((finding) => finding.level === "error");
  }

  get warnings(): readonly PipelineValidationFinding[] {
    return this.findings.filter((finding) => finding.level === "warning");
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }
}

/** Aggregated error: independent rules can report several problems at once. */
export class PipelineValidationError extends Error {
  readonly findings: readonly PipelineValidationFinding[];

  constructor(source: string, findings: readonly PipelineValidationFinding[]) {
    const details = findings.map((finding) => `- [${finding.rule}] ${finding.message}`).join("\n");
    super(`Invalid pipeline (${source}):\n${details}`);
    this.name = "PipelineValidationError";
    this.findings = findings;
  }
}

/**
 * Extensible chain of consistency rules.
 *
 * It collects diagnostics instead of stopping at the first error. Future rules
 * can be added without bloating the loader or mixing invariants.
 */
export class PipelineValidationChain {
  constructor(private readonly rules: readonly PipelineValidationRule[]) {}

  validate(context: PipelineValidationContext): PipelineValidationReport {
    const findings: PipelineValidationFinding[] = [];
    for (const rule of this.rules) findings.push(...rule.validate(context));
    return new PipelineValidationReport(findings);
  }

  assertValid(context: PipelineValidationContext): void {
    const report = this.validate(context);
    if (!report.ok) throw new PipelineValidationError(context.source, report.errors);
  }
}

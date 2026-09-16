import { optionalEnum, optionalNumber, optionalString, optionalStrings, record } from "./artifact-parsing.js";
import type { LotArtifact, LotsArtifact, PlanAuditArtifact, PlanAuditLotFinding } from "./artifact-types.js";
import { PLAN_AUDIT_SEVERITIES } from "./artifact-types.js";

const LOT_ID = /^LOT-\d{2,}$/;

function positiveIntegers(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number" && Number.isInteger(item) && item > 0)) {
    throw new Error(`lots.json: ${field} must be an array of positive integers`);
  }
  const result = value as number[];
  if (new Set(result).size !== result.length) throw new Error(`lots.json: ${field} contains a duplicate`);
  return result;
}

/** Strictly parse the lot manifest; plan/AC partition checks remain in validateLots. */
export function parseLotsArtifact(value: unknown): LotsArtifact {
  const data = record(value, "lots.json");
  if (!Array.isArray(data.lots) || data.lots.length === 0) {
    throw new Error("lots.json: at least one lot is required");
  }
  const ids = new Set<string>();
  const lots = data.lots.map((entry, index): LotArtifact => {
    const item = record(entry, `lots.json: lots[${index}]`);
    if (typeof item.id !== "string" || !LOT_ID.test(item.id)) {
      throw new Error(`lots.json: lots[${index}].id is invalid`);
    }
    if (ids.has(item.id)) throw new Error(`lots.json: duplicate id ${item.id}`);
    ids.add(item.id);
    if (typeof item.title !== "string" || item.title.trim() === "") {
      throw new Error(`lots.json: ${item.id}.title must be non-empty`);
    }
    if (typeof item.risk !== "number" || !Number.isInteger(item.risk) || item.risk < 0 || item.risk > 8) {
      throw new Error(`lots.json: ${item.id}.risk must be an integer between 0 and 8`);
    }
    const steps = positiveIntegers(item.steps, `${item.id}.steps`);
    const dependsOn = optionalStrings(item.dependsOn);
    if (!dependsOn) throw new Error(`lots.json: ${item.id}.dependsOn must be an array of strings`);
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`lots.json: ${item.id}.dependsOn contains a duplicate`);
    }
    const acceptanceCriteria = optionalStrings(item.acceptanceCriteria);
    if (!acceptanceCriteria) {
      throw new Error(`lots.json: ${item.id}.acceptanceCriteria must be an array of strings`);
    }
    for (const ac of acceptanceCriteria) {
      if (!/^AC-\d+$/.test(ac)) throw new Error(`lots.json: ${item.id}: invalid AC ${ac}`);
    }
    return { id: item.id, title: item.title, risk: item.risk, steps, dependsOn, acceptanceCriteria };
  });

  for (const lot of lots) {
    for (const dependency of lot.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`lots.json: unknown dependency ${dependency}`);
      if (dependency === lot.id) throw new Error(`lots.json: ${lot.id} depends on itself`);
    }
  }

  const remaining = new Map(lots.map((lot) => [lot.id, new Set(lot.dependsOn)]));
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) throw new Error("lots.json: circular dependencies");
    for (const id of ready) {
      remaining.delete(id);
      for (const deps of remaining.values()) deps.delete(id);
    }
  }
  return {
    lots,
    ...(typeof data.reason === "string" && data.reason.trim() ? { reason: data.reason } : {}),
  };
}

/** Strict shape parse for plan-audit: missing findings must not mean no defects. */
export function parsePlanAuditArtifact(value: unknown): PlanAuditArtifact {
  const data = record(value, "plan-audit.json");
  if (typeof data.audited !== "boolean") throw new Error("plan-audit.json: boolean `audited` is required");
  if (!Array.isArray(data.lotFindings)) {
    throw new Error("plan-audit.json: `lotFindings` must be an array");
  }
  const lotFindings = data.lotFindings.map((entry, index): PlanAuditLotFinding => {
    const item = record(entry, `plan-audit.json: lotFindings[${index}]`);
    const severity = optionalEnum(item.severity, PLAN_AUDIT_SEVERITIES);
    if (!severity) {
      throw new Error(
        `plan-audit.json: lotFindings[${index}].severity must be one of ${PLAN_AUDIT_SEVERITIES.join(" | ")}`,
      );
    }
    const summary = optionalString(item.summary)?.trim();
    if (!summary) throw new Error(`plan-audit.json: lotFindings[${index}].summary must be non-empty`);
    const lot = optionalString(item.lot)?.trim();
    const category = optionalString(item.category)?.trim();
    return { severity, summary, ...(lot ? { lot } : {}), ...(category ? { category } : {}) };
  });
  const planFixes = optionalNumber(data.planFixes);
  return {
    audited: data.audited,
    lotFindings,
    ...(planFixes !== undefined && planFixes >= 0 ? { planFixes } : {}),
  };
}

/** A CRITICAL/HIGH lot finding stops automation. */
export const blocksLots = (finding: PlanAuditLotFinding): boolean =>
  finding.severity === "CRITICAL" || finding.severity === "HIGH";

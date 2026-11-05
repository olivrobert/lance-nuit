import { optionalBoolean, optionalEnum, optionalString, optionalStrings, record } from "./artifact-parsing.js";
import type {
  AssumptionsArtifact,
  InputsArtifact,
  RedtestArtifact,
  ReuseArtifact,
  TriageArtifact,
} from "./artifact-types.js";

/** Parse triage while rejecting the only field that can create a path or branch. */
export function parseTriageArtifact(value: unknown): TriageArtifact {
  const data = record(value, "triage.json");
  const slug = optionalString(data.slug);
  if (slug != null && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug)) {
    throw new Error(`triage.json: invalid slug "${slug}"`);
  }
  return {
    ...data,
    verdict: optionalEnum(data.verdict, ["proceed", "escalate"]),
    complexity: optionalEnum(data.complexity, ["trivial", "standard"]),
    size: optionalEnum(data.size, ["xs", "small", "standard"]),
    anchors: optionalStrings(data.anchors),
    risk: optionalEnum(data.risk, ["low", "normal"]),
    reason: optionalString(data.reason),
    slug,
    missing: optionalStrings(data.missing),
    surface: optionalString(data.surface),
    homogeneous: optionalBoolean(data.homogeneous),
    sensitive: optionalBoolean(data.sensitive),
    ambiguity: optionalString(data.ambiguity),
  };
}

export function parseRedtestArtifact(value: unknown): RedtestArtifact {
  const data = record(value, "redtest.json");
  return {
    ok: optionalBoolean(data.ok),
    blocked: optionalBoolean(data.blocked),
    reason: optionalString(data.reason),
    testFile: optionalString(data.testFile),
  };
}

export function parseReuseArtifact(value: unknown): ReuseArtifact {
  const data = record(value, "reuse.json");
  return {
    duplication: optionalBoolean(data.duplication),
    violations: Array.isArray(data.violations) ? data.violations : undefined,
  };
}

/** Strict shape parse: missing `blocking` must never silently mean zero assumptions. */
export function parseAssumptionsArtifact(value: unknown): AssumptionsArtifact {
  const data = record(value, "assumptions.json");
  if (!Array.isArray(data.blocking)) {
    throw new Error("assumptions.json: `blocking` must be an array");
  }
  const blocking = data.blocking.map((entry) => {
    const item = record(entry, "assumptions.json: blocking[]");
    return {
      subject: optionalString(item.subject),
      assumed: optionalString(item.assumed),
      ac: optionalString(item.ac),
    };
  });
  // `resolved` is informational: malformed data degrades the note only.
  const resolved = Array.isArray(data.resolved)
    ? data.resolved
        .filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry),
        )
        .map((entry) => ({
          subject: optionalString(entry.subject),
          answer: optionalString(entry.answer),
          evidence: optionalString(entry.evidence),
        }))
    : [];
  return resolved.length > 0 ? { blocking, resolved } : { blocking };
}

function inputFileName(value: unknown, index: number): string {
  if (typeof value !== "string") throw new Error(`inputs.json: required[${index}].path must be a string`);
  const name = value.trim();
  if (name === "") throw new Error(`inputs.json: required[${index}].path is empty`);
  if (name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw new Error(`inputs.json: required[${index}].path "${value}" must be a simple filename`);
  }
  return name;
}

/** Strict shape parse: missing `required` must never silently mean no inputs. */
export function parseInputsArtifact(value: unknown): InputsArtifact {
  const data = record(value, "inputs.json");
  if (!Array.isArray(data.required)) {
    throw new Error("inputs.json: `required` must be an array");
  }
  const required = data.required.map((entry, index) => {
    const item = record(entry, `inputs.json: required[${index}]`);
    return { path: inputFileName(item.path, index), why: optionalString(item.why) ?? "" };
  });
  const names = required.map((item) => item.path);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error(`inputs.json: duplicate path "${duplicate}"`);
  return { required, seen: optionalStrings(data.seen) ?? [] };
}

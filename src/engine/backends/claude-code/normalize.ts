import type { ClaudeOptions, ClaudeStepOptions } from "./types.js";

export type { ClaudeOptions, ClaudeStepOptions } from "./types.js";
export function normalizeClaudeStepOptions(options?: ClaudeStepOptions): ClaudeOptions | undefined {
  if (options === undefined) return undefined;
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error("Invalid Claude options: an object is expected");
  const raw = options as Record<string, unknown>,
    allowed = new Set([
      "agent",
      "systemPrompt",
      "tools",
      "allowedTools",
      "strictMcp",
      "settingSources",
      "permissionMode",
    ]),
    unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length) throw new Error(`Claude options: unknown key(s) ${unknown.join(", ")} (expected: camelCase)`);
  const str = (k: "agent" | "systemPrompt" | "settingSources") =>
    raw[k] === undefined
      ? undefined
      : typeof raw[k] === "string"
        ? (raw[k] as string)
        : (() => {
            throw new Error(`Claude options: ${k} must be a string`);
          })();
  const list = (k: "tools" | "allowedTools") =>
    raw[k] === undefined
      ? undefined
      : Array.isArray(raw[k]) && raw[k].every((v) => typeof v === "string")
        ? [...(raw[k] as string[])]
        : (() => {
            throw new Error(`Claude options: ${k} must be a string array`);
          })();
  if (raw.strictMcp !== undefined && typeof raw.strictMcp !== "boolean")
    throw new Error("Claude options: strictMcp must be boolean");
  const p = raw.permissionMode;
  if (p !== undefined && !(["default", "plan", "acceptEdits", "bypassPermissions"] as unknown[]).includes(p))
    throw new Error(`Claude options: invalid permissionMode (${String(p)})`);
  const r: ClaudeOptions = {};
  const a = str("agent"),
    s = str("systemPrompt"),
    ss = str("settingSources"),
    t = list("tools"),
    at = list("allowedTools");
  if (a !== undefined) r.agent = a;
  if (s !== undefined) r.system_prompt = s;
  if (ss !== undefined) r.setting_sources = ss;
  if (t) r.tools = t;
  if (at) r.allowed_tools = at;
  if (raw.strictMcp !== undefined) r.strict_mcp = raw.strictMcp as boolean;
  if (p !== undefined) r.permission_mode = p as ClaudeOptions["permission_mode"];
  return r;
}

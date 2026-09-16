// runner/lib/tool-label.ts
//
// One naming convention for tool calls, shared by every surface that shows them
// (live status line, tmux formatter, attempt telemetry). A tool named the same
// way everywhere is what makes a run's console and its journal comparable.

type ToolInput = Record<string, unknown> | undefined;

function record(value: unknown): ToolInput {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** File-bearing tools read better as `<Tool> <basename>` than as a full path. */
function fileLabel(tool: string, input: ToolInput): string {
  const path = text(input?.file_path);
  return path ? `${tool} ${basename(path)}` : tool;
}

/** Short label for a tool call. Never throws: the input is untrusted stream data. */
export function toolLabel(name: string, rawInput: unknown): string {
  const input = record(rawInput);
  switch (name) {
    case "Skill":
      return `skill(${text(input?.skill) ?? "?"})`;
    case "Agent":
      return `agent(${text(input?.subagent_type) ?? text(input?.name) ?? "?"})`;
    case "Read":
    case "Edit":
    case "Write":
      return fileLabel(name, input);
    case "Grep": {
      const pattern = truncate(text(input?.pattern) ?? "", 40);
      const path = text(input?.path);
      return `Grep "${pattern}"${path ? ` in ${basename(path)}` : ""}`;
    }
    case "Glob":
      return `Glob ${truncate(text(input?.pattern) ?? "", 40)}`;
    case "Bash":
      return `Bash ${text(input?.description) ?? truncate(text(input?.command) ?? "", 60)}`;
    case "TaskCreate":
      return `TaskCreate(${truncate(text(input?.subject) ?? "", 40)})`;
    default:
      return name;
  }
}

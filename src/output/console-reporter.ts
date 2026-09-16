import { relative, resolve } from "node:path";
import type { AgentBackendRegistry, StepControl, StepUsage } from "../contracts/backends.js";
import type { RunStep, RunView } from "../model/run.js";
import { log, writeStderr } from "../runtime/logging.js";
import { bold, cyan, dim, gray, green, red, type Style, yellow } from "./color.js";
import { formatContextShare, formatDuration } from "./format.js";
import {
  buildRunReport,
  type RunReport,
  type RunReportKind,
  type RunReportOutcome,
  type RunReportStep,
  stepResumeHint,
} from "./run-report.js";
import { CONTEXT_WARN_PCT } from "./status-line.js";

export { formatDuration } from "./format.js";

export interface TextDestination {
  write(text: string): void;
}

export interface RunReporter {
  report(report: RunReport): void;
}

export const stderrDestination: TextDestination = {
  write(text: string): void {
    writeStderr(text.endsWith("\n") ? text : `${text}\n`);
  },
};

/** Three outcome families, three colors: green succeeded, red needs a fix, and
 * yellow needs a decision. Grey is for what simply did not happen. */
const STATUS: Record<RunReportKind, { icon: string; label: string; tint: Style }> = {
  success: { icon: "✓", label: "SUCCESS", tint: green },
  verdict: { icon: "!", label: "ACTION REQUIRED", tint: yellow },
  failure: { icon: "✗", label: "FAILURE", tint: red },
  stopped: { icon: "■", label: "STOPPED", tint: gray },
  aborted: { icon: "■", label: "ABORTED", tint: gray },
  budget: { icon: "!", label: "BUDGET EXCEEDED", tint: yellow },
  cost: { icon: "!", label: "COST UNACCOUNTED", tint: yellow },
  unknown: { icon: "?", label: "INCOMPLETE", tint: gray },
};

const STEP_ICON: Record<RunReportStep["status"], { icon: string; tint: Style }> = {
  done: { icon: "✓", tint: green },
  failed: { icon: "✗", tint: red },
  aborted: { icon: "■", tint: gray },
  running: { icon: "▶", tint: cyan },
  pending: { icon: "·", tint: gray },
  skipped: { icon: "⊘", tint: gray },
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/** Context occupancy of a step's last turn, as a percentage of its window.
 *
 * Deliberately NOT reported on a run total: each step opens its own session, so
 * summing or averaging occupancies would describe a context that never existed.
 * Only a single step's figure means anything. */
export function fmtContextShare(control?: StepControl): string | undefined {
  const { last_turn_context_tokens: tokens, context_window: window } = control ?? {};
  if (!tokens || !window) return undefined;
  return formatContextShare(tokens / window);
}

function metrics(control?: StepControl, usage?: StepUsage): string[] {
  const parts: string[] = [];
  const duration = formatDuration(control?.duration_ms);
  if (duration) parts.push(duration);
  // An unpriced attempt makes every figure it feeds a floor. `≥` is the one
  // convention for that across the console, `lancenuit stats`, and the dashboard:
  // an unknown spend is never printed as an exact amount, least of all as `$0.00`.
  if (control?.total_cost_usd != null)
    parts.push(`${control.cost_unknown ? "≥ " : ""}$${control.total_cost_usd.toFixed(2)}`);
  if (usage?.output_tokens) parts.push(`${formatNumber(usage.output_tokens)} tok`);
  return parts;
}

/** Metrics are background information and read as dim — except an occupancy that
 * has crossed the warning threshold, which is the one number worth looking at.
 * Styles do not nest, so the highlighted part is tinted on its own and the runs
 * around it are dimmed separately. The parts keep the order they were given. */
function paintMetrics(parts: string[], highlight?: string): string {
  const at = highlight ? parts.indexOf(highlight) : -1;
  if (at < 0) return parts.length > 0 ? dim(parts.join(" · ")) : "";
  const before = parts.slice(0, at);
  const after = parts.slice(at + 1);
  // One dim run per side, separators included: adjacent runs would emit twice
  // the escapes for the same result.
  return [
    before.length > 0 ? dim(`${before.join(" · ")} · `) : "",
    yellow(parts[at]),
    after.length > 0 ? dim(` · ${after.join(" · ")}`) : "",
  ].join("");
}

/** The part to highlight, if the occupancy has reached the warning threshold. */
function contextHighlight(control?: StepControl): string | undefined {
  const { last_turn_context_tokens: tokens, context_window: window } = control ?? {};
  if (!tokens || !window || tokens / window < CONTEXT_WARN_PCT) return undefined;
  return fmtContextShare(control);
}

function withContext(parts: string[], control?: StepControl): string[] {
  const context = fmtContextShare(control);
  return context ? [...parts, context] : parts;
}

export function fmtInlineStats(control?: StepControl, usage?: StepUsage): string {
  const painted = paintMetrics(withContext(metrics(control, usage), control), contextHighlight(control));
  return painted ? ` ${dim("·")} ${painted}` : "";
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function summaryCounts(report: RunReport): string {
  const { done, skipped, failed, aborted, pending, running } = report.statusCounts;
  return [
    done ? plural(done, "completed", "completed") : "",
    skipped ? plural(skipped, "skipped") : "",
    failed ? plural(failed, "failed", "failed") : "",
    aborted ? plural(aborted, "aborted") : "",
    pending ? plural(pending, "not run") : "",
    running ? plural(running, "running", "running") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function wrap(text: string, width = 96): string[] {
  const result: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = "";
    for (const word of words) {
      if (!line) line = word;
      else if (line.length + word.length + 1 <= width) line += ` ${word}`;
      else {
        result.push(line);
        line = word;
      }
    }
    if (line) result.push(line);
  }
  return result;
}

function displayPath(path: string, cwd: string): string {
  const rel = relative(resolve(cwd), resolve(path));
  return rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ? `./${rel}` : path;
}

function stepMetrics(step: RunReportStep): string {
  const control = step.control ?? (step.durationMs != null ? { duration_ms: step.durationMs } : undefined);
  const parts = withContext(metrics(control, step.usage), control);
  if (step.retries > 0) parts.push(plural(step.retries, "retry"));
  const painted = paintMetrics(parts, contextHighlight(control));
  return painted ? `  ${painted}` : "";
}

function visibleSteps(report: RunReport): { steps: RunReportStep[]; omittedDone: number } {
  const executed = report.steps.filter(({ status }) => !["pending", "skipped"].includes(status));
  const failures = executed.filter(({ status }) => status === "failed" || status === "aborted");
  const ordinary = executed.filter(({ status }) => status !== "failed" && status !== "aborted");
  const keptOrdinary = ordinary.slice(-8);
  return {
    steps: [...keptOrdinary, ...failures.filter((step) => !keptOrdinary.includes(step))].sort(
      (left, right) => report.steps.indexOf(left) - report.steps.indexOf(right),
    ),
    omittedDone: ordinary.length - keptOrdinary.length,
  };
}

export function renderConsoleReport(report: RunReport, options: { cwd?: string } = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const status = STATUS[report.kind];
  const identity = [report.pipeline, report.ticket].filter(Boolean).join(" · ");
  const total = metrics(report.totalControl, report.totalUsage);
  const bar = dim("│");
  const lines = [
    "",
    `${dim("╭─")} ${status.tint(`${status.icon} ${status.label}`)}${identity ? dim(` · ${identity}`) : ""}`,
    `${bar}  ${bold(report.headline)}`,
    `${bar}  ${summaryCounts(report) || "No steps recorded"}`,
  ];
  if (total.length > 0) lines.push(`${bar}  ${dim(total.join(" · "))}`);
  if (report.budget) {
    // A budget that is spent past its limit is the reason the run stopped, so it
    // is tinted like the outcome rather than dimmed like ordinary metrics.
    const floor = report.budget.costUnknown ? "≥ " : "";
    const text = `Budget ${floor}$${report.budget.spent.toFixed(2)} / $${report.budget.limit.toFixed(2)}`;
    lines.push(`${bar}  ${report.budget.spent >= report.budget.limit ? yellow(text) : dim(text)}`);
    // An unpriced attempt makes the figure above a floor, not a total: say so
    // rather than let a comfortable margin be read as a real one.
    if (report.budget.costUnknown)
      lines.push(`${bar}  ${yellow("⚠ At least one attempt had no computable cost: spend is under-counted")}`);
  }
  lines.push(report.action ? `${dim("╰─")} ${report.action}` : dim("╰────────────────────────────────────────"));
  // The one command that lifts the stop, outside the box and undimmed: it is
  // meant to be copied, like a resume hint.
  if (report.recovery) lines.push(`   ${cyan("↻")} ${report.recovery}`);

  const visible = visibleSteps(report);
  if (visible.steps.length > 0) {
    lines.push("", bold("Executed steps"));
    for (const step of visible.steps) {
      const { icon, tint } = STEP_ICON[step.status];
      lines.push(`  ${tint(icon)} ${step.name}${stepMetrics(step)}`);
    }
  }
  const collapsed = [
    visible.omittedDone ? plural(visible.omittedDone, "completed step hidden", "completed steps hidden") : "",
    report.statusCounts.skipped ? plural(report.statusCounts.skipped, "step skipped", "steps skipped") : "",
    report.statusCounts.pending ? plural(report.statusCounts.pending, "step not run", "steps not run") : "",
  ].filter(Boolean);
  if (collapsed.length > 0) lines.push(dim(`  └─ ${collapsed.join(" · ")}`));

  if (report.issue) {
    lines.push("", bold(report.kind === "verdict" ? "Verdict" : "Diagnostic"));
    for (const line of wrap(report.issue)) lines.push(`  ${line}`);
  }

  if (report.resumptions.length > 0) {
    lines.push("", bold("Resumptions"));
    for (const resume of report.resumptions) {
      lines.push(`  ${resume.step}${dim(` · ${resume.provider} · ${resume.sessionId}`)}`);
      // The resume command is meant to be copied: it stays undimmed.
      if (resume.command) lines.push(`    ${cyan("↻")} ${resume.command}`);
      // Without this line the command reads as what a rerun will do. It is not:
      // an interrupted step is replayed on a brand new session.
      if (resume.nature === "inspect")
        lines.push(dim("    to read this conversation by hand · a rerun starts a fresh session"));
      if (resume.location) lines.push(dim(`    session ${displayPath(resume.location, cwd)}`));
    }
  }

  lines.push("", bold("Files"));
  const width = Math.max(...report.resources.map(({ label }) => label.length));
  for (const resource of report.resources) {
    // Pad BEFORE tinting: escape sequences would otherwise count as columns.
    lines.push(`  ${dim(resource.label.padEnd(width))}  ${displayPath(resource.path, cwd)}`);
  }
  return `${lines.join("\n")}\n`;
}

export class ConsoleRunReporter implements RunReporter {
  constructor(
    private readonly destination: TextDestination = stderrDestination,
    private readonly cwd = process.cwd(),
  ) {}

  report(report: RunReport): void {
    this.destination.write(renderConsoleReport(report, { cwd: this.cwd }));
  }
}

export function consoleReport(
  run: RunView,
  outcome: RunReportOutcome,
  options: { statsPath?: string | null; registry?: AgentBackendRegistry } = {},
): void {
  new ConsoleRunReporter().report(buildRunReport(run, outcome, options));
}

export function logStepStarted(step: RunStep, index: number, total: number): void {
  log(`\n${dim("┌─")} ${bold(step.def.name)}${dim(` · ${index}/${total}`)}`);
}

export function logStepSession(sessionId: string): void {
  log(dim(`│  session  ${sessionId}`));
}

export function logStepLogs(path: string, live: boolean): void {
  log(dim(`│  logs     ${path}${live ? " · live: tail -F" : ""}`));
}

export function logStepDone(step: RunStep, suffix = ""): void {
  log(`${dim("└─")} ${green("✓ Completed")}${suffix}${fmtInlineStats(step.control, step.usage)}`);
  const hint = stepResumeHint(step);
  if (hint) log(`   ${cyan("↻")} ${hint}`);
}

export function logStepFailed(step: RunStep, suffix = ""): void {
  // A block outranks the kind in the label: printing "Error" or "Failed" sends an
  // operator to the logs of a step that ran fine, when the environment is what
  // has to change.
  //
  // The reachable case is a step that ends `failed` WITHOUT stopping the run: its
  // retry budget was spent and the last rerun came back blocked, so
  // `settleStepFailure` emits `step.failed` while `step.fail_cause` still holds
  // the cause the attempt wrote. The canonical blocked path does not come through
  // here at all — `resolveOutcome` calls `updateStep` + `stopRun` and prints its
  // own `⏹ … non-code block` line instead of emitting `step.failed`.
  const blocked = step.fail_cause === "blocked";
  const label = blocked ? "Blocked" : step.fail_kind === "verdict" ? "Failed" : "Error";
  const separator = suffix.indexOf(" — ");
  const qualifier = separator >= 0 ? suffix.slice(0, separator) : suffix;
  const detail = separator >= 0 ? suffix.slice(separator + 3) : undefined;
  // A verdict is a decision to take, a technical error is a break: yellow vs red.
  // A block is neither broken nor a judgment on the code, so it takes yellow too.
  const tint = blocked || step.fail_kind === "verdict" ? yellow : red;
  log(`${dim("└─")} ${tint(`✗ ${label}`)}${qualifier}${fmtInlineStats(step.control, step.usage)}`);
  if (detail) {
    for (const line of wrap(detail, 92)) log(`   ${line}`);
  }
  const hint = stepResumeHint(step);
  if (hint) log(`   ${cyan("↻")} ${hint}`);
}

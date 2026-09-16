// output/status-line.ts
//
// Repainting single-line progress indicator for the main console.
//
// Between a step header and its outcome the runner is silent — often for
// minutes. This destination fills that silence WITHOUT scrolling: one line,
// rewritten in place, erased before any other stderr write so ordinary logs
// stay byte-for-byte what they were.
//
// On a non-TTY (CI, `| tee`, redirection) nothing is ever written: carriage
// returns and erase sequences in a captured log are worse than no progress at
// all. That check is the module's only feature flag — the destination stays in
// the fan-out either way, and simply does nothing.

import type { RunnerEvent } from "../runtime/events.js";
import { setLogInterceptor } from "../runtime/logging.js";
import { cyan, dim, visibleLength, yellow } from "./color.js";
import { formatContextShare } from "./format.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 1000;
/** Erase from the cursor to the end of the line (CSI K). */
const ERASE = "\r\x1b[K";

/** Above this occupancy the spinner becomes a warning: the step is at risk of
 * being compacted or truncated, which is worth seeing before it happens. */
export const CONTEXT_WARN_PCT = 0.8;

export interface StatusLineStream {
  write(text: string): void;
  isTTY?: boolean;
  columns?: number;
}

interface StatusLineState {
  step: string;
  startedAt: number;
  activity?: string;
  pct?: number;
}

/** `4m12s` reads well in a report; a ticking clock reads better as `4:12`. */
export function formatElapsed(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}:${rest}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`;
}

/**
 * Compose the line (no cursor control), so it can be asserted.
 *
 * When the line does not fit, the ACTIVITY is what gets clipped: the clock and
 * the occupancy are the two values being watched, and a progress line that
 * drops them to keep a file name has lost its reason to exist.
 */
export function renderStatusLine(state: StatusLineState, elapsedMs: number, frame: number, width = 0): string {
  const warn = state.pct != null && state.pct >= CONTEXT_WARN_PCT;
  const icon = warn ? yellow("⚠") : cyan(FRAMES[frame % FRAMES.length]);
  const share = state.pct != null ? formatContextShare(state.pct) : undefined;
  const tail = [formatElapsed(elapsedMs), ...(share && !warn ? [share] : [])].join(" · ");
  const label = clip(state.activity ?? state.step, width - visibleLength(`│  ${icon} ${tail} · `) - 1);
  const painted = [dim("│"), "  ", icon, " ", label, dim(` · ${tail}`)];
  if (warn && share) painted.push(dim(" · "), yellow(share));
  return painted.join("");
}

/** `max <= 0` means "no known width": leave the text alone rather than erase it.
 * The ellipsis counts toward the budget, so a one-column budget is the ellipsis
 * alone — clamping the slice instead would overflow by exactly one column. */
function clip(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return max === 1 ? "…" : `${text.slice(0, max - 1)}…`;
}

/**
 * A `RunOutput` by structural typing: it is deliberately not importing that
 * module, which would pull console-reporter and logging into a cycle with the
 * interceptor registered here.
 */
export class StatusLineOutput {
  private state: StatusLineState | undefined;

  private timer: NodeJS.Timeout | undefined;

  private painted = false;

  private frame = 0;

  constructor(
    private readonly stream: StatusLineStream = process.stderr,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.stream.isTTY === true;
  }

  /** Take ownership of stderr and return the matching release function. */
  attach(): () => void {
    if (!this.enabled) return () => {};
    setLogInterceptor(() => this.clear());
    return () => {
      this.stop();
      setLogInterceptor(undefined);
    };
  }

  emit(event: RunnerEvent): void {
    if (!this.enabled) return;
    switch (event.type) {
      case "step.started":
        this.state = { step: event.step.def.name, startedAt: this.now() };
        this.start();
        break;
      case "step.done":
      case "step.failed":
        this.stop();
        break;
      case "runner-event":
        this.observe(event);
        break;
      default:
        break;
    }
  }

  /** Backend telemetry only refines the CURRENT step; it never opens a line of
   * its own, so late events from a finished step cannot resurrect the spinner. */
  private observe(event: Extract<RunnerEvent, { type: "runner-event" }>): void {
    if (!this.state) return;
    if (event.event === "context") this.state.pct = event.pct;
    else if (event.event === "activity") this.state.activity = event.label;
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.paint(), TICK_MS);
    // The runner must never be held open by its own progress indicator.
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clear();
    this.state = undefined;
  }

  private paint(): void {
    if (!this.state) return;
    const line = renderStatusLine(
      this.state,
      this.now() - this.state.startedAt,
      this.frame++,
      this.stream.columns ?? 0,
    );
    this.stream.write(`\r${line}\x1b[K`);
    this.painted = true;
  }

  /** Erase the line so the next writer starts on clean ground. Idempotent: the
   * interceptor runs before EVERY stderr write, including consecutive ones. */
  private clear(): void {
    if (!this.painted) return;
    this.stream.write(ERASE);
    this.painted = false;
  }
}

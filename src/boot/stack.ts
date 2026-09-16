// runner/boot/stack.ts
//
// Docker stack preflight: ensure required services are healthy before the first
// step.
//
// Without the preflight, the first step's agent discovers the stopped stack,
// runs the start command, and waits. That wait consumes the step timeout, leaving a
// killed process, wasted budget, and a misleading `process killed: timeout`
// diagnostic.
//
// Position in BOOT[]: after the lock. Starting a stack only to discover that
// another runner owns the project would waste work.
//
// This work is outside step budgets because boot runs before `loadOrCreateRun`,
// which starts the step timers.

import type { StackPreflightConfig } from "../env/config.js";
import { probeComposeServices, unreadyServices } from "../env/docker-stack.js";
import { runSupervisedCommand } from "../exec/process-runner.js";
import { log } from "../runtime/logging.js";
import type { BootState, BootStep } from "./boot-state.js";

/** Delay between readiness probes. */
const POLL_INTERVAL_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StackPreflightOutcome {
  ok: boolean;
  /** Failure message naming the services that are not ready. */
  reason?: string;
}

/**
 * Testable preflight core without `process.exit` or a BootState dependency.
 *
 * `now` and `sleep` are injectable so tests do not wait for real polling delays.
 */
export async function ensureStackReady(
  cwd: string,
  preflight: StackPreflightConfig,
  deps: {
    probe: (cwd: string, timeoutMs: number) => Promise<Awaited<ReturnType<typeof probeComposeServices>>>;
    start: (cwd: string, command: string, timeoutMs: number) => Promise<{ status: number; timedOut: boolean }>;
    now: () => number;
    wait: (ms: number) => Promise<void>;
  },
): Promise<StackPreflightOutcome> {
  const deadline = deps.now() + preflight.readinessTimeoutMs;
  const probeTimeout = Math.min(preflight.readinessTimeoutMs, 30_000);

  const check = async (): Promise<{ reachable: boolean; unready: string[] }> => {
    const services = await deps.probe(cwd, probeTimeout);
    // A failed probe means Docker is unreachable. Do not report every service as
    // missing; the probe failure is the useful cause.
    if (services === null) return { reachable: false, unready: [] };
    return { reachable: true, unready: unreadyServices(preflight.services, services) };
  };

  const initial = await check();
  if (initial.reachable && initial.unready.length === 0) return { ok: true };

  const missing = initial.reachable ? initial.unready.join(", ") : "docker compose is unreachable";
  log(`Docker stack is not ready (${missing}) — ${preflight.startCommand}…`);

  const startTimeout = Math.max(deadline - deps.now(), 0);
  if (startTimeout === 0) {
    return { ok: false, reason: `Docker stack is not ready: ${missing} (preflight budget exhausted)` };
  }
  const started = await deps.start(cwd, preflight.startCommand, startTimeout);
  if (started.timedOut) {
    return {
      ok: false,
      reason: `Docker stack is not ready: \`${preflight.startCommand}\` timed out after ${Math.round(preflight.readinessTimeoutMs / 1000)}s`,
    };
  }

  // The start command may return before healthchecks converge: its exit code is not
  // enough, so the probe is authoritative. A non-zero code is not fatal if the
  // services are healthy afterward.
  let last = await check();
  while ((!last.reachable || last.unready.length > 0) && deps.now() < deadline) {
    await deps.wait(POLL_INTERVAL_MS);
    last = await check();
  }

  if (last.reachable && last.unready.length === 0) {
    log("Docker stack is ready.");
    return { ok: true };
  }

  if (!last.reachable) {
    return {
      ok: false,
      reason:
        "Docker stack is not ready: docker compose is unreachable (daemon stopped, or no compose file in this directory)",
    };
  }
  const detail = started.status === 0 ? "" : ` (\`${preflight.startCommand}\` returned ${started.status})`;
  return { ok: false, reason: `Docker stack is not ready: ${last.unready.join(", ")}${detail}` };
}

export const stackStep: BootStep = {
  id: "stack",
  desc: "Ensure required Docker services are started and healthy before the first step.",
  applies: (s: BootState) => !!s.config?.stackPreflight,
  async run(s: BootState): Promise<Partial<BootState>> {
    const preflight = s.config!.stackPreflight!;
    const cwd = process.cwd();
    const outcome = await ensureStackReady(cwd, preflight, {
      probe: probeComposeServices,
      start: async (dir, command, timeoutMs) => {
        const result = await runSupervisedCommand("bash", ["-c", command], { cwd: dir, timeoutMs, stdio: "inherit" });
        return { status: result.status, timedOut: result.timedOut };
      },
      now: () => Date.now(),
      wait: sleep,
    });

    if (!outcome.ok) {
      // Fail here instead of letting a step time out later; this layer knows the
      // actual cause.
      log.error(outcome.reason ?? "Docker stack is not ready");
      process.exit(1);
    }
    return {};
  },
};

// runner/env/docker-stack.ts
//
// Probe for a `docker compose` stack, shared by boot preflight (boot/stack.ts)
// and worktree setup (env/worktree.ts).
//
// One source of truth for TWO distinct questions:
//   - "are any containers running?"        → stackHasRunningContainers
//   - "are these specific services ready?" → unreadyServices
//
// The latter is the only one that can identify the failing service:
// `docker compose ps -q` only says that something is running, which remains true
// while the database is up but not healthy yet.

import { runSupervisedCommand } from "../exec/process-runner.js";
import { type ComposeService, readComposeService } from "./docker-stack.schema.js";

export type { ComposeService } from "./docker-stack.schema.js";

export const STACK_PROBE_TIMEOUT_MS = 30_000;

/**
 * `docker compose ps --format json` returns one object per line (JSONL) since
 * Compose v2.21, and one JSON array before that. Both are accepted because the
 * runner does not control the installed Docker version.
 *
 * Entry shape and its tolerance live in `docker-stack.schema.ts`: an entry that
 * is not an object, or that names no service, is skipped rather than rejected —
 * a required service missing from the result is then reported as `(absent)` by
 * `unreadyServices`, so a malformed entry never reads as ready.
 */
export function parseComposePs(stdout: string): ComposeService[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.map(readComposeService).filter((s): s is ComposeService => s !== null) : [];
    } catch {
      // Invalid aggregate output is not a readiness result; callers treat it as no services.
      return [];
    }
  }

  const services: ComposeService[] = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      const service = readComposeService(JSON.parse(line));
      if (service) services.push(service);
    } catch {
      // An unreadable line (a Docker warning mixed into the stream) does not
      // invalidate the other lines.
    }
  }
  return services;
}

/** A service is ready when it is running AND its healthcheck is not failing.
 *  Empty `health` means no healthcheck is declared, so `running` is authoritative. */
export function isServiceReady(service: ComposeService): boolean {
  return service.state === "running" && (service.health === "" || service.health === "healthy");
}

/**
 * Describe what is missing, using Docker vocabulary, so the error names the
 * failing service AND its exact state (`db (exited)`, `elasticsearch (running/starting)`,
 * `mailer (absent)`).
 */
export function unreadyServices(required: readonly string[], services: readonly ComposeService[]): string[] {
  const byName = new Map(services.map((service) => [service.service, service]));
  const unready: string[] = [];
  for (const name of required) {
    const service = byName.get(name);
    if (!service) {
      unready.push(`${name} (absent)`);
      continue;
    }
    if (isServiceReady(service)) continue;
    unready.push(`${name} (${service.health ? `${service.state || "?"}/${service.health}` : service.state || "?"})`);
  }
  return unready;
}

/**
 * Probe service state. `null` means the probe itself failed (Docker missing, no
 * compose file, daemon down); this differs from "no containers", and callers
 * handle the two cases differently.
 */
export async function probeComposeServices(
  cwd: string,
  timeoutMs: number = STACK_PROBE_TIMEOUT_MS,
): Promise<ComposeService[] | null> {
  const result = await runSupervisedCommand("bash", ["-c", "docker compose ps --all --format json 2>/dev/null"], {
    cwd,
    timeoutMs,
  });
  if (result.status !== 0) return null;
  return parseComposePs(result.stdout);
}

/** Coarse question: is the stack up, without requiring a service list? */
export async function stackHasRunningContainers(
  cwd: string,
  timeoutMs: number = STACK_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const services = await probeComposeServices(cwd, timeoutMs);
  return services?.some((service) => service.state === "running") ?? false;
}

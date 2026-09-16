import { expect, test } from "bun:test";
import type { PipelineConfig, StackPreflightConfig } from "../env/config.ts";
import type { ComposeService } from "../env/docker-stack.ts";
import type { RunnerArgs } from "../model/cli-options.ts";
import { ensureStackReady, stackStep } from "./stack.ts";
import type { BootState } from "./boot-state.ts";
import { createDefaultRunnerRegistries } from "../entry/registries.js";

const PREFLIGHT: StackPreflightConfig = {
  services: ["php", "db"],
  startCommand: "make start",
  readinessTimeoutMs: 30_000,
};

const UP: ComposeService[] = [
  { service: "php", state: "running", health: "healthy" },
  { service: "db", state: "running", health: "healthy" },
];
const DOWN: ComposeService[] = [
  { service: "php", state: "exited", health: "" },
  { service: "db", state: "exited", health: "" },
];

/** Virtual clock: `wait` advances time instead of sleeping. */
function deps(
  probes: (ComposeService[] | null)[],
  start: { status: number; timedOut: boolean } = { status: 0, timedOut: false },
) {
  let clock = 0;
  const calls = { probe: 0, start: 0, waited: 0 };
  return {
    calls,
    deps: {
      probe: async () => {
        const index = Math.min(calls.probe++, probes.length - 1);
        return probes[index]!;
      },
      start: async () => {
        calls.start++;
        return start;
      },
      now: () => clock,
      wait: async (ms: number) => {
        calls.waited++;
        clock += ms;
      },
    },
  };
}

test("stack already ready: no start, one probe", async () => {
  const { calls, deps: d } = deps([UP]);
  expect(await ensureStackReady("/repo", PREFLIGHT, d)).toEqual({ ok: true });
  expect(calls.start).toBe(0);
  expect(calls.probe).toBe(1);
});

test("stack down: starts, then proceeds when readiness converges", async () => {
  const { calls, deps: d } = deps([DOWN, DOWN, UP]);
  expect(await ensureStackReady("/repo", PREFLIGHT, d)).toEqual({ ok: true });
  expect(calls.start).toBe(1);
});

test("readiness never reached: failure names the faulty service", async () => {
  const partial: ComposeService[] = [
    { service: "php", state: "running", health: "healthy" },
    { service: "db", state: "running", health: "unhealthy" },
  ];
  const { deps: d } = deps([partial]);
  const outcome = await ensureStackReady("/repo", PREFLIGHT, d);
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toContain("db (running/unhealthy)");
});

test("missing service is named as such", async () => {
  const { deps: d } = deps([[{ service: "php", state: "running", health: "healthy" }]]);
  const outcome = await ensureStackReady("/repo", PREFLIGHT, d);
  expect(outcome.reason).toContain("db (absent)");
});

test("startCommand killed by budget: failure says so", async () => {
  const { deps: d } = deps([DOWN], { status: 143, timedOut: true });
  const outcome = await ensureStackReady("/repo", PREFLIGHT, d);
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toContain("make start");
  expect(outcome.reason).toContain("30s");
});

test("docker unreachable: reported cause is the probe, not the services", async () => {
  const { deps: d } = deps([null]);
  const outcome = await ensureStackReady("/repo", PREFLIGHT, d);
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toContain("docker compose is unreachable");
});

test("startCommand fails but services are ready: run still starts", async () => {
  const { deps: d } = deps([DOWN, UP], { status: 2, timedOut: false });
  expect(await ensureStackReady("/repo", PREFLIGHT, d)).toEqual({ ok: true });
});

test("startCommand fails AND services are not ready: exit code is reported", async () => {
  const { deps: d } = deps([DOWN], { status: 2, timedOut: false });
  const outcome = await ensureStackReady("/repo", PREFLIGHT, d);
  expect(outcome.reason).toContain("returned 2");
});

function state(config: Partial<PipelineConfig>): BootState {
  return {
    args: {} as RunnerArgs,
    cwd: "/repo",
    worktreeMode: false,
    baseRegistries: createDefaultRunnerRegistries(),
    config: config as PipelineConfig,
  };
}

test("applies: without stackPreflight in config, no probe", () => {
  expect(stackStep.applies(state({}))).toBe(false);
  expect(
    stackStep.applies({
      args: {} as RunnerArgs,
      cwd: "/repo",
      worktreeMode: false,
      baseRegistries: createDefaultRunnerRegistries(),
    }),
  ).toBe(false);
});

test("applies: declared stackPreflight enables preflight", () => {
  expect(stackStep.applies(state({ stackPreflight: PREFLIGHT }))).toBe(true);
});

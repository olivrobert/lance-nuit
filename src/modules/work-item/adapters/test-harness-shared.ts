import { errorMessage } from "../../../lib/errors.js";
import type { ProcessResult, ProcessRunner } from "../process/runner.js";

export const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });
export const ko = (stderr: string, code = 1): ProcessResult => ({ code, stdout: "", stderr });

export function argValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

export function argValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]!);
  }
  return values;
}

export function inverseStringMap<T extends object>(values: T): Map<string, string> {
  const entries = Object.entries(values) as Array<[string, string]>;
  return new Map(entries.map(([key, value]) => [value, key]));
}

export function interruptGate<TKey>(): {
  arm(key: TKey, afterOps: number): void;
  shouldInterrupt(key: TKey): boolean;
} {
  let pending: { key: TKey; remaining: number } | undefined;
  return {
    arm: (key, afterOps) => {
      pending = { key, remaining: afterOps };
    },
    shouldInterrupt: (key) => {
      if (!pending || !Object.is(pending.key, key)) return false;
      if (pending.remaining > 0) {
        pending.remaining -= 1;
        return false;
      }
      pending = undefined;
      return true;
    },
  };
}

export function stubbedRunner(result: ProcessResult | ((cmd: string, args: string[]) => ProcessResult)): {
  run: ProcessRunner;
  commands: string[][];
} {
  const commands: string[][] = [];
  const run: ProcessRunner = async (cmd, args) => {
    commands.push([cmd, ...args]);
    return typeof result === "function" ? result(cmd, args) : result;
  };
  return { run, commands };
}

export function stubbedGateway<T>(
  result: ProcessResult | ((cmd: string, args: string[]) => ProcessResult),
  create: (run: ProcessRunner) => T,
): { gateway: T; commands: string[][] } {
  const { run, commands } = stubbedRunner(result);
  return { gateway: create(run), commands };
}

export function gatewayHarness<TSim extends { run: ProcessRunner }, TGateway>(
  sim: TSim,
  create: (run: ProcessRunner) => TGateway,
): { gateway: TGateway; sim: TSim } {
  return { gateway: create(sim.run), sim };
}

export function matchingCommands(
  commands: readonly string[][],
  prefix: readonly string[],
  actionIndex: number,
  action: string,
): string[][] {
  return commands.filter(
    (command) => prefix.every((part, index) => command[index] === part) && command[actionIndex] === action,
  );
}

export async function messageOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    return "";
  } catch (error) {
    return errorMessage(error);
  }
}

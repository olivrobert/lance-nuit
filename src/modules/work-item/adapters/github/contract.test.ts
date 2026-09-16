import { describe, expect, it } from "bun:test";
import { createWorkItemGatewayContract } from "../../../../contracts/testing.js";
import { githubFactory, simOf } from "./test-harness.js";

const runWorkItemGatewayContract = createWorkItemGatewayContract({ describe, it, expect });

runWorkItemGatewayContract("github (simulated gh)", githubFactory(), {
  rendering: "markdown",
  refs: { known: "24", second: "25", closed: "26", unknown: "9999", invalid: "not-an-issue" },
  readNotes: (gateway, ref) => [...(simOf(gateway).issueOf(Number(ref))?.comments ?? [])],
  armMoveInterrupt: (gateway, ref, afterOps) => simOf(gateway).armInterrupt(Number(ref), afterOps),
});

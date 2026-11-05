import { describe, expect, it } from "bun:test";
import { createWorkItemGatewayContract } from "../../../../contracts/testing.js";
import { jiraFactory, simOf } from "./test-harness.js";

const runWorkItemGatewayContract = createWorkItemGatewayContract({ describe, it, expect });

runWorkItemGatewayContract("jira (simulated acli)", jiraFactory(), {
  rendering: "plain",
  refs: { known: "PROJ-24", second: "PROJ-25", closed: "PROJ-26", unknown: "PROJ-9999", invalid: "not a reference" },
  readNotes: (gateway, ref) => [...(simOf(gateway).ticketOf(ref)?.comments ?? [])],
  armMoveInterrupt: (gateway, ref, afterOps) => simOf(gateway).armInterrupt(ref, afterOps),
  appliedOperations: (gateway) => simOf(gateway).mutations,
});

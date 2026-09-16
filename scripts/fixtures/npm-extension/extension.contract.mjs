import { describe, expect, it } from "bun:test";
import { createWorkItemGatewayContract } from "lance-nuit/contracts/testing";
import { createGateway } from "./extension.mjs";

createWorkItemGatewayContract({ describe, expect, it })("installed consumer extension", createGateway, {
  readNotes: (gateway, ref) => gateway.readNotes(ref),
});

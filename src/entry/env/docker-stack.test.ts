import { expect, test } from "bun:test";
import { isServiceReady, parseComposePs, unreadyServices } from "./docker-stack.ts";

test("parseComposePs: JSONL format (compose >= 2.21)", () => {
  const stdout = [
    '{"Service":"php","State":"running","Health":"healthy"}',
    '{"Service":"db","State":"running","Health":"starting"}',
  ].join("\n");
  expect(parseComposePs(stdout)).toEqual([
    { service: "php", state: "running", health: "healthy" },
    { service: "db", state: "running", health: "starting" },
  ]);
});

test("parseComposePs: JSON array format (compose < 2.21)", () => {
  const stdout = '[{"Service":"php","State":"exited","Health":""}]';
  expect(parseComposePs(stdout)).toEqual([{ service: "php", state: "exited", health: "" }]);
});

test("parseComposePs: an unreadable line does not invalidate the others", () => {
  const stdout = ["warning: something", '{"Service":"php","State":"running"}'].join("\n");
  expect(parseComposePs(stdout)).toEqual([{ service: "php", state: "running", health: "" }]);
});

test("parseComposePs: empty output", () => {
  expect(parseComposePs("  \n ")).toEqual([]);
});

test("parseComposePs: falls back to Name when Service is absent", () => {
  expect(parseComposePs('{"Name":"proj-db-1","State":"running"}')).toEqual([
    { service: "proj-db-1", state: "running", health: "" },
  ]);
});

test("isServiceReady: running without healthcheck is ready", () => {
  expect(isServiceReady({ service: "php", state: "running", health: "" })).toBe(true);
});

test("isServiceReady: running but starting is not ready", () => {
  expect(isServiceReady({ service: "db", state: "running", health: "starting" })).toBe(false);
});

test("isServiceReady: healthy but not running is not ready", () => {
  expect(isServiceReady({ service: "db", state: "exited", health: "healthy" })).toBe(false);
});

test("unreadyServices: names the service and its state", () => {
  const services = [
    { service: "php", state: "running", health: "healthy" },
    { service: "db", state: "running", health: "unhealthy" },
    { service: "es", state: "exited", health: "" },
  ];
  expect(unreadyServices(["php", "db", "es", "mailer"], services)).toEqual([
    "db (running/unhealthy)",
    "es (exited)",
    "mailer (absent)",
  ]);
});

test("unreadyServices: complete stack returns nothing", () => {
  const services = [{ service: "php", state: "running", health: "healthy" }];
  expect(unreadyServices(["php"], services)).toEqual([]);
});

test("unreadyServices: non-required services are ignored", () => {
  const services = [
    { service: "php", state: "running", health: "healthy" },
    { service: "adminer", state: "exited", health: "" },
  ];
  expect(unreadyServices(["php"], services)).toEqual([]);
});

// An entry of an unexpected shape is skipped, never fatal: the preflight then
// reports the required service as absent. See `docker-stack.schema.ts`.
test("parseComposePs: an entry of an unexpected shape is skipped, and reads as absent", () => {
  const stdout = [
    '{"Service":"php","State":"running","Health":"healthy"}',
    '{"State":"running"}',
    '"a bare string"',
    "42",
  ].join("\n");
  const services = parseComposePs(stdout);
  expect(services).toEqual([{ service: "php", state: "running", health: "healthy" }]);
  expect(unreadyServices(["php", "db"], services)).toEqual(["db (absent)"]);
});

test("parseComposePs: unknown Docker fields pass through without disturbing the entry", () => {
  const stdout =
    '{"ID":"abc","Service":"db","State":"running","Health":"healthy","Publishers":[{"TargetPort":5432}],"ExitCode":0}';
  expect(parseComposePs(stdout)).toEqual([{ service: "db", state: "running", health: "healthy" }]);
});

test("parseComposePs: a field of the wrong kind reads as empty, never as ready", () => {
  const services = parseComposePs('{"Service":"db","State":null,"Health":42}');
  expect(services).toEqual([{ service: "db", state: "", health: "" }]);
  expect(isServiceReady(services[0]!)).toBe(false);
});

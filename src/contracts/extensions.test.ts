import { describe, expect, test } from "bun:test";
import { EXTENSION_MANIFEST_KEYS, type ExtensionManifest, defineExtension } from "./extensions.js";

describe("extension manifest contract", () => {
  test("defineExtension returns the manifest unchanged and registers nothing", () => {
    const manifest = { workItems: [{ id: "redmine", create: () => ({}) as never }] };
    expect(defineExtension(manifest)).toBe(manifest);
  });

  test("defineExtension accepts an empty manifest", () => {
    expect(defineExtension({})).toEqual({});
  });

  test("the accepted keys are exactly the manifest's properties", () => {
    const manifest: Required<ExtensionManifest> = { backends: [], workItems: [] };
    expect([...EXTENSION_MANIFEST_KEYS].sort()).toEqual(Object.keys(manifest).sort() as (keyof ExtensionManifest)[]);
  });
});

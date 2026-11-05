// Work-item note builders: run facts → structured note.

import { expect, test } from "bun:test";
import { deliveryNote } from "./work-item-notes.js";

test("delivery: MR URL appears in headline", () => {
  const note = deliveryNote("https://gitlab.example.com/g/p/-/merge_requests/42");
  expect(note.headline).toBe("MR opened automatically: https://gitlab.example.com/g/p/-/merge_requests/42");
  expect(note.fields).toEqual([]);
});

test("delivery: empty URL → manual MR creation, not an error", () => {
  for (const url of ["", "   "]) {
    expect(deliveryNote(url).headline).toBe("Branch pushed; MR must be created manually.");
  }
});

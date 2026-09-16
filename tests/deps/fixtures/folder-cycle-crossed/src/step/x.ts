// Fixture: two folders of the same layer that depend on each other through two
// disjoint file edges. No file is part of a cycle, so `no-circular` stays
// silent and only the folder-level check can see `step` and `boot` locked
// together.
import { x } from "../boot/x.js";

export const stepX = x;

// Fixture: a file importing the facade of its own context, which would be a cycle.
import { internal } from "./index.js";

export const own = internal;

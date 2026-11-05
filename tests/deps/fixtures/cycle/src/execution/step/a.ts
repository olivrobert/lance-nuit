// Fixture: two modules of the same layer importing each other. Must raise
// `no-circular` and no layer rule.
import { b } from "./b.js";

export const a = () => b();

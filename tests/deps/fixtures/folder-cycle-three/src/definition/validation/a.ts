// Fixture: a three-folder cycle, `dispatch -> boot -> pipeline -> dispatch`,
// made of four files none of which sits in a file-level cycle.
import { boot } from "../pipeline/a.js";

export const a = boot;

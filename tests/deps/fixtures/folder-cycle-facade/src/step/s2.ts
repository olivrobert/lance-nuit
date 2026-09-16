// The facade is imported from another folder, so `src/dsl.ts` is a node of the
// grouped graph in its own right: the cycle runs `dsl.ts -> dsl -> step ->
// dsl.ts`, and merging the facade into the folder of the same name would lose
// two of its four edges.
import { a } from "../dsl.js";

export const s2 = a;

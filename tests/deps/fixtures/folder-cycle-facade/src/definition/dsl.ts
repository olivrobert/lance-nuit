// Fixture: a facade file next to a folder of the same name. `src/definition/dsl.ts` and
// `src/definition/dsl/` are two distinct nodes, so the cycle runs through three of them,
// `dsl.ts -> dsl -> validation -> dsl.ts`, and not through two.
export { a } from "./dsl/a.js";

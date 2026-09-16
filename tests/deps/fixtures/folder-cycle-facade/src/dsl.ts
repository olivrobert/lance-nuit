// Fixture: a facade file next to a folder of the same name. `src/dsl.ts` and
// `src/dsl/` are two distinct nodes, so the cycle runs through three of them,
// `dsl.ts -> dsl -> step -> dsl.ts`, and not through two.
export { a } from "./dsl/a.js";

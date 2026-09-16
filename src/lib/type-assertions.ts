// lib/type-assertions.ts
//
// Compile-time helpers used by runtime schemas to prove that a schema and a
// hand-written interface describe the same data. Types only: this module has no
// runtime code and no import, so it is harmless if a declaration reaches it.
//
// Usage, in a `*.schema.ts` module:
//
//   type _Output = AssertAssignable<z.output<typeof Schema>, Interface>;
//   type _Input = AssertAssignable<Plain<Interface>, z.input<typeof Schema>>;
//
// The first line proves that what the schema produces satisfies the interface.
// The second proves that an existing value of the interface is accepted by the
// schema (old files stay readable). See `guide/architecture.md`, section
// "Persistence and observability".

/** Fails to compile unless `T` is assignable to `U`. */
export type AssertAssignable<_T extends U, U> = true;

/**
 * Maps an interface to a structurally identical type alias. Interfaces have no
 * implicit index signature, so they cannot be compared directly with the loose
 * (indexed) input type of a `looseObject` schema.
 */
export type Plain<T> = T extends readonly (infer U)[]
  ? Plain<U>[]
  : T extends object
    ? { [K in keyof T]: Plain<T[K]> }
    : T;

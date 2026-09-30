// runner/tests/isolate-actor.ts
//
// Suite preload: drop the `LANCENUIT_ACTOR` the developer's shell may export.
//
// A decision records that name as its author (state/decisions.ts), so an ambient
// value turns every "anonymous human" assertion into the developer's name — a
// failure that reproduces neither in CI nor on another machine.
//
// A test that wants to EXERCISE the actor sets `process.env.LANCENUIT_ACTOR`
// itself, or passes an explicit env to `decisionActor`.

delete process.env.LANCENUIT_ACTOR;

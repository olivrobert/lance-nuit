// Dependency-free on purpose: backend option types sit in the public
// declaration graph, so anything they import must not pull runtime modules in.

/** Spawn notification shape shared by every process-backed backend. */
export interface BackendSpawnEvent<P extends string = string> {
  readonly type: "agent-spawn";
  readonly provider: P;
  readonly model?: string;
  readonly timestamp: number;
}

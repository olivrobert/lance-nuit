import type { PipelineLabels, WorkItemConfig } from "./config.js";
import type { WorkItemGateway } from "./types.js";

export interface WorkItemGatewayDeps {
  workItem: WorkItemConfig;
  labels: PipelineLabels;
}

export type WorkItemGatewayFactory = (deps: WorkItemGatewayDeps) => WorkItemGateway;

export interface WorkItemGatewayRegistration {
  readonly id: string;
  readonly create: WorkItemGatewayFactory;
}

/** Pure provider registry. Composition packages decide which registrations exist. */
export class WorkItemGatewayRegistry {
  private readonly factories = new Map<string, WorkItemGatewayFactory>();

  register(registration: WorkItemGatewayRegistration): this {
    const id = registration.id.trim();
    if (!id) throw new Error("Work-item provider: id must be non-empty");
    if (typeof registration.create !== "function")
      throw new Error(`Work-item provider "${id}": create must be a function`);
    if (this.factories.has(id)) throw new Error(`Work-item provider: "${id}" is already registered`);
    this.factories.set(id, registration.create);
    return this;
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  known(): readonly string[] {
    return [...this.factories.keys()];
  }

  resolve(deps: WorkItemGatewayDeps): WorkItemGateway {
    const factory = this.factories.get(deps.workItem.provider);
    if (!factory)
      throw new Error(
        `work-item: provider "${deps.workItem.provider}" unknown (known: ${this.known().join(", ") || "none"})`,
      );
    return factory(deps);
  }
}

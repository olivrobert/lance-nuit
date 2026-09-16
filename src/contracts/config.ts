/** Provider-neutral configuration consumed by work-item factories. */
export interface PipelineLabels {
  bugTodo: string;
  featureTodo: string;
  done: string;
  escalate: string;
}

/** Provider identifier and logical state projection. */
export interface WorkItemConfig {
  provider: string;
  project: string;
  todoState: string;
  reviewState: string;
  baseUrl?: string;
}

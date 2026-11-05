import type { AgentBackendRegistry } from "../../contracts/backends.js";
import { isLogicalSegment } from "../../shared/language/artifact-ports.js";
import type { PipelineStep } from "../definition.js";
import {
  backendRegistryOf,
  type PipelineValidationContext,
  type PipelineValidationFinding,
  type PipelineValidationRule,
} from "./types.js";

/**
 * What `parallelize` may hold. Every member runs at the same time as its siblings, in
 * the same git tree, so everything here is either a write that would land on a
 * sibling's work, or an order the group no longer guarantees.
 *
 * Refused at load: at run time these would surface as a lost output or a broken tree,
 * after the money was spent.
 */
export class ParallelGroupValidator implements PipelineValidationRule {
  readonly id = "parallel-group";

  validate(context: PipelineValidationContext): readonly PipelineValidationFinding[] {
    const steps = Array.isArray(context.pipeline.steps)
      ? context.pipeline.steps.filter(
          (step): step is PipelineStep => !!step && typeof step === "object" && typeof step.id === "string",
        )
      : [];
    const groupIds = new Set(steps.flatMap((step) => step.parallel_group?.id ?? []));
    return [...groupIds].flatMap((groupId) =>
      problemsOfGroup(groupId, steps, backendRegistryOf(context)).map((problem) => ({
        rule: this.id,
        level: "error" as const,
        message: `parallel group "${groupId}": ${problem}`,
      })),
    );
  }
}

function problemsOfGroup(groupId: string, steps: readonly PipelineStep[], registry: AgentBackendRegistry): string[] {
  const members = steps.filter((step) => step.parallel_group?.id === groupId);
  return [
    ...problemsOfShape(groupId, steps, members),
    ...members.flatMap((member) =>
      problemsOfMember(groupId, member, registry).map((why) => `step "${member.id}": ${why}`),
    ),
    ...problemsBetweenMembers(members),
  ];
}

function problemsOfShape(groupId: string, steps: readonly PipelineStep[], members: readonly PipelineStep[]): string[] {
  const problems: string[] = [];
  if (!isLogicalSegment(groupId)) problems.push("id must be a non-empty safe logical value");
  if (members.length < 2) problems.push(`needs at least 2 steps, found ${members.length}`);
  const first = steps.indexOf(members[0]!);
  const contiguous = members.every((member, offset) => steps[first + offset] === member);
  if (!contiguous) problems.push("its steps must be declared together, with no other step between them");
  // `--steps <group>` selects by this prefix: a stranger under it would run with the
  // group, and a step named like the group would be selected along with it.
  for (const step of steps) {
    if (step.parallel_group?.id === groupId) continue;
    if (step.id === groupId) problems.push(`step "${step.id}" has the id of the group`);
    if (step.id.startsWith(`${groupId}.`)) problems.push(`step "${step.id}" uses its prefix but is not in the group`);
  }
  return problems;
}

function problemsOfMember(groupId: string, member: PipelineStep, registry: AgentBackendRegistry): string[] {
  const problems: string[] = [];
  if (member.runner !== "agent") problems.push("a group holds only agent steps (llmStep)");
  if (!member.id.startsWith(`${groupId}.`)) problems.push(`id must start with "${groupId}."`);
  if (member.on_failure?.fix_prompt !== undefined) {
    problems.push("onFail.fix is refused, a repair writes to the code the siblings are reading; use retries");
  }
  if (member.rework_for?.length) {
    problems.push(`cannot be the rework step of "${member.rework_for.join(", ")}", it would replay without its group`);
  }
  const writeGrant = member.backend && registry.writeGrantOf(member.backend);
  if (writeGrant) problems.push(`${writeGrant} lets it write to the code the siblings are reading`);
  return problems;
}

function problemsBetweenMembers(members: readonly PipelineStep[]): string[] {
  const problems: string[] = [];
  members.forEach((member, index) => {
    for (const sibling of members.slice(index + 1)) {
      for (const output of member.outputs ?? []) {
        if (sibling.outputs?.some((other) => other.name === output.name)) {
          problems.push(`steps "${member.id}" and "${sibling.id}" share output "${output.name}"`);
        }
      }
      for (const path of member.report_paths ?? []) {
        if (sibling.report_paths?.includes(path)) {
          problems.push(`steps "${member.id}" and "${sibling.id}" share report "${path}"`);
        }
      }
    }
    for (const sibling of members) {
      if (sibling === member) continue;
      for (const input of member.sources ?? []) {
        if (input.kind !== "source" && sibling.outputs?.some((output) => output.name === input.name)) {
          problems.push(
            `step "${member.id}" reads "${input.name}", the output of "${sibling.id}", which is not written yet`,
          );
        }
      }
    }
  });
  return problems;
}

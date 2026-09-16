import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineContext } from "../model/context.js";
import type { PipelineWorkItemSource } from "../model/definition.js";
import { ActionStepBuilder } from "./dsl-steps.js";
import type { InternalWorkItemSourceOptions } from "./dsl-types.js";
import { declareWorkItemSource } from "./work-item-assembly.js";

export type { InternalWorkItemSourceOptions } from "./dsl-types.js";

class InternalWorkItemSourceStepBuilder extends ActionStepBuilder {
  constructor(id: string, name: string, source: PipelineWorkItemSource) {
    super(id, name);
    declareWorkItemSource(this, source);
  }
}

function ticketMarkdown(
  item: { title: string; description: string; comments?: readonly string[] },
  url?: string,
): string {
  const front = url ? `---\nurl: ${url}\n---\n\n` : "";
  const comments = (item.comments ?? []).map((body) => body.trim()).filter((body) => body.length > 0);
  const exchanges = comments.length > 0 ? `\n## Exchanges\n\n${comments.map((body) => `- ${body}`).join("\n")}\n` : "";
  return `${front}# ${item.title}\n\n${item.description}\n${exchanges}`;
}

export function resolveWorkItemDir(ctx: PipelineContext, explicitDir?: string): string {
  const dir = explicitDir ?? ctx.paths.artifactsDir;
  if (typeof dir !== "string" || dir.trim().length === 0) {
    throw new Error("Work-item directory not found: provide a ticket context or explicit dir to forEachWorkItem()");
  }
  return dir;
}

export function createInternalWorkItemSourceStep(opts: InternalWorkItemSourceOptions): ActionStepBuilder {
  if (!opts || typeof opts !== "object" || typeof opts.dir !== "function") {
    throw new Error("Invalid work-item source: dir must be a function");
  }
  if (opts.queue !== "bugTodo" && opts.queue !== "featureTodo") {
    throw new Error("Work-item source: queue must be bugTodo or featureTodo");
  }
  const id = opts.id ?? "ticket";
  const source: PipelineWorkItemSource = {
    step_id: id,
    queue: opts.queue,
    ...(opts.scan ? { scan: { ...opts.scan } } : {}),
  };

  return new InternalWorkItemSourceStepBuilder(id, opts.name ?? "Read ticket (work item → ticket.md)", source)
    .run(async (ctx) => {
      const ticket = ctx.ticket;
      if (!ticket) throw new Error(`${id}: ticket missing — nothing to read`);

      const valid = ctx.workItem.validateRef(ticket);
      if (!valid.ok) {
        throw new Error(`${id}: reference "${ticket}" rejected by ${ctx.workItem.provider} — ${valid.reason}`);
      }

      const item = await ctx.workItem.fetch(ticket);
      if (opts.refuseClosed && item.closed) {
        throw new Error(
          `${id}: ticket ${ticket} is already closed in ${ctx.workItem.provider} — run rejected (nothing to develop on a closed ticket; reopen it or create a new one)`,
        );
      }
      const baseUrl = ctx.config.workItem.baseUrl?.replace(/\/+$/, "");
      const dir = opts.dir(ctx);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "ticket.md");
      const next = ticketMarkdown(item, baseUrl ? `${baseUrl}/${ticket}` : undefined);
      const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
      if (current === next) return `ticket.md unchanged from ${ctx.workItem.provider} (${item.title})`;
      writeFileSync(path, next);
      const verb = current === undefined ? "written" : "updated";
      return `ticket.md ${verb} from ${ctx.workItem.provider} (${item.title})`;
    })
    .describe((ctx) => `${ctx.workItem.provider} ${ctx.ticket ?? "?"} → ${opts.dir(ctx)}/ticket.md`);
}

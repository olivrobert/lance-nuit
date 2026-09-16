import { defineExtension, hasMarker, isPipelineNote, renderPlainText } from "lance-nuit/contracts";

// Consumer-owned provider: all imports must resolve from the installed tarball.
export function createGateway() {
  const items = new Map(
    [24, 25, 26].map((id) => [
      `PROJ-${id}`,
      {
        ref: `PROJ-${id}`,
        title: "Installed extension ticket",
        description: "Offline acceptance criteria",
        closed: id === 26,
        comments: [],
        queues: new Set(),
        state: "todo",
      },
    ]),
  );

  function item(ref) {
    if (!items.has(ref)) throw new Error(`Unknown ticket ${ref}`);
    return items.get(ref);
  }

  return {
    provider: "npm-smoke",
    validateRef: (ref) => (/^PROJ-\d+$/.test(ref) ? { ok: true } : { ok: false, reason: "Invalid reference" }),
    async fetch(ref) {
      const value = item(ref);
      return {
        ref,
        title: value.title,
        description: value.description,
        closed: value.closed,
        comments: value.comments.filter((body) => !isPipelineNote(body)),
      };
    },
    async findCandidates({ queue, state }) {
      return [...items.values()]
        .filter((value) => value.queues.has(queue) && value.state === state)
        .map((value) => value.ref);
    },
    async comment(ref, note, key) {
      const value = item(ref);
      if (!value.comments.some((body) => hasMarker(body, key))) value.comments.push(renderPlainText(note, key));
    },
    async moveTo(ref, target) {
      const value = item(ref);
      if (target.queue) value.queues.add(target.queue);
      if (target.from) value.queues.delete(target.from);
      if (target.state) value.state = target.state;
    },
    readNotes: (ref) => item(ref).comments,
  };
}

export default defineExtension({ workItems: [{ id: "npm-smoke", create: createGateway }] });

// The byte plumbing between the terminal stream and xterm, kept free of both.
//
// The bridge to tmux is SSE for output and plain POSTs for input (a WebSocket
// upgrade does not work under the Bun the server runs on). That choice leaves
// two small problems on the browser side, and both are solved here, as pure
// code, so they can be tested without a browser:
//
//   output  every `data` event carries the pane's raw bytes in base64, because
//           an SSE frame is text and terminal output is not. They must reach
//           `term.write` as bytes, never as a decoded string: a UTF-8 sequence
//           split across two frames would otherwise turn into two replacement
//           characters. xterm reassembles split sequences itself.
//
//   input   xterm reports every keystroke — and a paste as one burst — through
//           `onData`. One POST per key would reorder keys whenever two requests
//           race, so the batcher coalesces what arrives within a few
//           milliseconds and keeps at most ONE request in flight: whatever is
//           typed meanwhile waits and leaves, in order, when the previous one
//           answered.

/** Base64 text to the bytes it encodes. */
export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The bytes of one `data` event. The contract sends the base64 as a JSON
 * string (`data: "…"`); a bare base64 payload is accepted as well, so the
 * terminal keeps working whichever of the two the server settles on.
 */
export function decodeDataEvent(raw: string): Uint8Array {
  const text = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  return decodeBase64(text);
}

/** Timer functions, injected so a test drives time by hand. */
export interface BatchTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: BatchTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface InputBatcher {
  /** Queue typed text; it leaves after `delayMs` of quiet, in order. */
  push(data: string): void;
  /** Drop whatever is queued and send nothing more. */
  cancel(): void;
}

export function createInputBatcher(
  send: (data: string) => Promise<void>,
  delayMs = 10,
  timers: BatchTimers = REAL_TIMERS,
): InputBatcher {
  let queued = "";
  let timer: unknown = null;
  let inFlight = false;
  let cancelled = false;

  function schedule(): void {
    if (timer !== null || inFlight || cancelled || !queued) return;
    timer = timers.set(() => {
      timer = null;
      void flush();
    }, delayMs);
  }

  async function flush(): Promise<void> {
    if (inFlight || cancelled || !queued) return;
    const data = queued;
    queued = "";
    inFlight = true;
    try {
      await send(data);
    } catch {
      // `send` reports its own failure to the screen; the batcher only has to
      // stay usable for the next keystroke.
    } finally {
      inFlight = false;
      schedule();
    }
  }

  return {
    push(data: string): void {
      if (cancelled || !data) return;
      queued += data;
      schedule();
    },
    cancel(): void {
      cancelled = true;
      queued = "";
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
  };
}

/** Terminal size the server accepts (`1..500` on each axis). */
export function clampSize(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(500, Math.max(1, Math.round(value)));
}

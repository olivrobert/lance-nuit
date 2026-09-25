import { describe, expect, test } from "bun:test";
import { type BatchTimers, clampSize, createInputBatcher, decodeBase64, decodeDataEvent } from "./terminal-io.js";

describe("decodeBase64 and decodeDataEvent", () => {
  test("gives back the raw bytes, a split UTF-8 sequence included", () => {
    const bytes = new Uint8Array([0x1b, 0x5b, 0x48, 0xc3]);
    const text = btoa(String.fromCharCode(...bytes));
    expect(decodeBase64(text)).toEqual(bytes);
  });

  test("accepts the payload as a JSON string or bare", () => {
    const text = btoa("hello");
    expect(new TextDecoder().decode(decodeDataEvent(JSON.stringify(text)))).toBe("hello");
    expect(new TextDecoder().decode(decodeDataEvent(text))).toBe("hello");
  });
});

/** Timers the test fires by hand. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let seq = 0;
  const timers: BatchTimers = {
    set(callback) {
      seq += 1;
      pending.set(seq, callback);
      return seq;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    count: () => pending.size,
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0));
}

describe("createInputBatcher", () => {
  test("coalesces keystrokes typed within the delay into one send", async () => {
    const clock = manualTimers();
    const sent: string[] = [];
    const batcher = createInputBatcher(async (data) => void sent.push(data), 10, clock.timers);
    batcher.push("l");
    batcher.push("s");
    batcher.push("\r");
    expect(clock.count()).toBe(1);
    clock.fire();
    await flush();
    expect(sent).toEqual(["ls\r"]);
  });

  test("keeps one request in flight and sends what was typed meanwhile after it, in order", async () => {
    const clock = manualTimers();
    const sent: string[] = [];
    let release!: () => void;
    const batcher = createInputBatcher(
      (data) => {
        sent.push(data);
        return new Promise<void>((done) => {
          release = done;
        });
      },
      10,
      clock.timers,
    );
    batcher.push("a");
    clock.fire();
    await flush();
    batcher.push("b");
    batcher.push("c");
    // Nothing scheduled while "a" is on the wire.
    expect(clock.count()).toBe(0);
    release();
    await flush();
    clock.fire();
    await flush();
    expect(sent).toEqual(["a", "bc"]);
  });

  test("a failed send does not stop the next one", async () => {
    const clock = manualTimers();
    const sent: string[] = [];
    const batcher = createInputBatcher(
      async (data) => {
        sent.push(data);
        if (data === "a") throw new Error("gone");
      },
      10,
      clock.timers,
    );
    batcher.push("a");
    clock.fire();
    await flush();
    batcher.push("b");
    clock.fire();
    await flush();
    expect(sent).toEqual(["a", "b"]);
  });

  test("cancel drops the queue and ignores later input", async () => {
    const clock = manualTimers();
    const sent: string[] = [];
    const batcher = createInputBatcher(async (data) => void sent.push(data), 10, clock.timers);
    batcher.push("x");
    batcher.cancel();
    batcher.push("y");
    clock.fire();
    await flush();
    expect(sent).toEqual([]);
    expect(clock.count()).toBe(0);
  });
});

describe("clampSize", () => {
  test("keeps a size inside 1..500", () => {
    expect(clampSize(80)).toBe(80);
    expect(clampSize(0)).toBe(1);
    expect(clampSize(9000)).toBe(500);
    expect(clampSize(Number.NaN)).toBe(1);
  });
});

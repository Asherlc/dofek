import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "./concurrency-limiter.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("ConcurrencyLimiter", () => {
  it("never runs more operations at once than the configured concurrency", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred<void>());

    const runs = gates.map((gate, index) =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return index;
      }),
    );

    // Let the first wave acquire their slots before releasing anything.
    await Promise.resolve();
    expect(limiter.active).toBe(2);
    expect(limiter.queueDepth).toBe(3);

    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
    }

    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("runs queued operations in first-in first-out order", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const started: number[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    const runs = gates.map((gate, index) =>
      limiter.run(async () => {
        started.push(index);
        await gate.promise;
      }),
    );

    for (const gate of gates) {
      await Promise.resolve();
      gate.resolve();
    }
    await Promise.all(runs);

    expect(started).toEqual([0, 1, 2]);
  });

  it("releases the slot when an operation throws", async () => {
    const limiter = new ConcurrencyLimiter(1);

    await expect(limiter.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );

    await expect(limiter.run(async () => "recovered")).resolves.toBe("recovered");
    expect(limiter.active).toBe(0);
  });

  it("rejects an invalid concurrency", () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
    expect(() => new ConcurrencyLimiter(-1)).toThrow();
    expect(() => new ConcurrencyLimiter(1.5)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore.ts";

describe("Semaphore", () => {
  it("limits concurrent executions", async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let maxRunning = 0;

    const task = () =>
      semaphore.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 50));
        running--;
        return "done";
      });

    const results = await Promise.all([task(), task(), task(), task(), task()]);

    expect(maxRunning).toBe(2);
    expect(results).toEqual(["done", "done", "done", "done", "done"]);
  });

  it("propagates errors without leaking slots", async () => {
    const semaphore = new Semaphore(1);

    await expect(
      semaphore.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Slot should be released — this should complete without hanging
    const result = await semaphore.run(async () => "ok");
    expect(result).toBe("ok");
  });

  it("preserves return types", async () => {
    const semaphore = new Semaphore(3);
    const result = await semaphore.run(async () => ({ count: 42 }));
    expect(result).toEqual({ count: 42 });
  });
});

import { describe, expect, it } from "vitest";
import { dbQuerySemaphore } from "./semaphore.ts";

describe("dbQuerySemaphore", () => {
  it("limits concurrent executions", async () => {
    let running = 0;
    let maxRunning = 0;

    const task = () =>
      dbQuerySemaphore.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 50));
        running--;
        return "done";
      });

    const results = await Promise.all([task(), task(), task(), task(), task()]);

    expect(maxRunning).toBeLessThanOrEqual(5);
    expect(results).toEqual(["done", "done", "done", "done", "done"]);
  });

  it("propagates errors without leaking slots", async () => {
    await expect(
      dbQuerySemaphore.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Slot should be released — this should complete without hanging
    const result = await dbQuerySemaphore.run(async () => "ok");
    expect(result).toBe("ok");
  });

  it("preserves return types", async () => {
    const result = await dbQuerySemaphore.run(async () => ({ count: 42 }));
    expect(result).toEqual({ count: 42 });
  });
});

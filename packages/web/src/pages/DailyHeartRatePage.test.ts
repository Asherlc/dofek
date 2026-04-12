import { describe, expect, it } from "vitest";

describe("DailyHeartRatePage", () => {
  it("exports the page component", async () => {
    const mod = await import("./DailyHeartRatePage.tsx");
    expect(mod.DailyHeartRatePage).toBeDefined();
    expect(typeof mod.DailyHeartRatePage).toBe("function");
  });
});

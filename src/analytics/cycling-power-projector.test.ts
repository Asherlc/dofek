import { describe, expect, it, vi } from "vitest";
import { cyclingPowerPolicy } from "./cycling-power-policy.ts";
import { projectCyclingPower } from "./cycling-power-projector.ts";

describe("cycling publication ownership", () => {
  it("checks its owner before source reads or publication", async () => {
    const failure = new Error("Publication owner is no longer active");
    const client = { query: vi.fn(), command: vi.fn(), insert: vi.fn() };
    const assertActive = vi.fn(async () => {
      throw failure;
    });
    await expect(projectCyclingPower({ client, assertActive }, cyclingPowerPolicy)).rejects.toBe(
      failure,
    );
    expect(client.query).not.toHaveBeenCalled();
    expect(client.command).not.toHaveBeenCalled();
  });
});

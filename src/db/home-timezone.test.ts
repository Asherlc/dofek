import { describe, expect, it, vi } from "vitest";
import { loadUserHomeTimezone } from "./home-timezone.ts";

describe("loadUserHomeTimezone", () => {
  it("returns a valid persisted IANA timezone", async () => {
    const execute = vi.fn().mockResolvedValue([{ value: "America/Los_Angeles" }]);

    await expect(
      loadUserHomeTimezone({ execute }, "00000000-0000-0000-0000-000000000001"),
    ).resolves.toBe("America/Los_Angeles");
  });
});

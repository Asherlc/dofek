import { describe, expect, it, vi } from "vitest";
import { loadUserHomeTimezone } from "./home-timezone.ts";

describe("loadUserHomeTimezone", () => {
  it("returns a valid persisted IANA timezone", async () => {
    const execute = vi.fn().mockResolvedValue([{ value: "  America/Los_Angeles  " }]);

    await expect(
      loadUserHomeTimezone({ execute }, "00000000-0000-0000-0000-000000000001"),
    ).resolves.toBe("America/Los_Angeles");
  });

  it.each([
    { label: "JSON null", rows: [{ value: null }] },
    { label: "missing setting", rows: [] },
    { label: "empty setting", rows: [{ value: "  " }] },
    { label: "invalid zone", rows: [{ value: "Not/AZone" }] },
    { label: "UTC alias", rows: [{ value: "UTC" }] },
    { label: "fixed Etc zone", rows: [{ value: "Etc/GMT+4" }] },
  ])("returns null for $label", async ({ rows }) => {
    const execute = vi.fn().mockResolvedValue(rows);

    await expect(
      loadUserHomeTimezone({ execute }, "00000000-0000-0000-0000-000000000001"),
    ).resolves.toBeNull();
  });
});

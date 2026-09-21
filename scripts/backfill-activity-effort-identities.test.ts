import { describe, expect, it } from "vitest";
import { parseActivityEffortIdentityAuditOptions } from "./backfill-activity-effort-identities.ts";

const userId = "00000000-0000-4000-8000-000000000001";

describe("parseActivityEffortIdentityAuditOptions", () => {
  it("requires a user-scoped UTC window", () => {
    expect(
      parseActivityEffortIdentityAuditOptions([
        "--user-id",
        userId,
        "--start",
        "2026-09-01T00:00:00.000Z",
        "--end",
        "2026-09-02T00:00:00.000Z",
      ]),
    ).toEqual({
      end: new Date("2026-09-02T00:00:00.000Z"),
      start: new Date("2026-09-01T00:00:00.000Z"),
      userId,
    });
  });

  it("rejects the removed write-mode flag", () => {
    expect(() =>
      parseActivityEffortIdentityAuditOptions([
        "--user-id",
        userId,
        "--start",
        "2026-09-01T00:00:00.000Z",
        "--end",
        "2026-09-02T00:00:00.000Z",
        "--execute",
      ]),
    ).toThrow("Unknown option '--execute'");
  });
});

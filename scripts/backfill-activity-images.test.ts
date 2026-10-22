import { describe, expect, it } from "vitest";
import { parseActivityImageBackfillArgs } from "./backfill-activity-images.ts";

describe("activity image backfill arguments", () => {
  it("requires one explicit owner and rejects unknown or duplicate flags", () => {
    for (const args of [
      [],
      ["--user-id", "not-uuid"],
      ["--all", "true"],
      ["--user-id", "00000000-0000-4000-8000-000000000001", "--status", "not-uuid"],
      [
        "--user-id",
        "00000000-0000-4000-8000-000000000001",
        "--user-id",
        "00000000-0000-4000-8000-000000000001",
      ],
    ])
      expect(() => parseActivityImageBackfillArgs(args)).toThrow();
  });
  it("selects a provider and resumes through status without changing owners", () =>
    expect(
      parseActivityImageBackfillArgs([
        "--user-id",
        "00000000-0000-4000-8000-000000000001",
        "--provider-id",
        "peloton",
        "--status",
        "00000000-0000-4000-8000-000000000002",
      ]),
    ).toEqual({
      userId: "00000000-0000-4000-8000-000000000001",
      providerId: "peloton",
      status: "00000000-0000-4000-8000-000000000002",
    }));
});

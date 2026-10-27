import { describe, expect, it } from "vitest";
import { ActivityRowSchema } from "./api";

describe("ActivityRowSchema", () => {
  it("normalizes omitted primary-type metadata to null in an older activity response", () => {
    const row = ActivityRowSchema.parse({
      id: "activity-1",
      started_at: "2026-03-18T07:00:00Z",
      canonical_type: "walking",
      name: null,
    });

    expect(row.primary_canonical_type).toBeNull();
    expect(row.canonical_type).toBe("walking");
  });

  it.each([
    { row: { started_at: "2026-03-18T07:00:00Z" }, missingField: "id" },
    { row: { id: "activity-1" }, missingField: "started_at" },
  ])("keeps the required $missingField field strict", ({ row, missingField }) => {
    const result = ActivityRowSchema.safeParse(row);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid activity data to be rejected");
    expect(result.error.issues.map((issue) => issue.path)).toEqual([[missingField]]);
  });

  it.each([null, "running"])(
    "retains supplied primary-type metadata (%j)",
    (primaryActivityType) => {
      expect(
        ActivityRowSchema.parse({
          id: "activity-1",
          started_at: "2026-03-18T07:00:00Z",
          canonical_type: "walking",
          primary_canonical_type: primaryActivityType,
          name: null,
        }),
      ).toMatchObject({ primary_canonical_type: primaryActivityType });
    },
  );

  it("rejects invalid supplied primary-type metadata", () => {
    const result = ActivityRowSchema.safeParse({
      id: "activity-1",
      started_at: "2026-03-18T07:00:00Z",
      primary_canonical_type: 42,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid primary-type metadata to be rejected");
    expect(result.error.issues.map((issue) => issue.path)).toEqual([["primary_canonical_type"]]);
  });

  it("normalizes legacy rows without a distance state", () => {
    expect(
      ActivityRowSchema.parse({
        id: "activity-1",
        primary_canonical_type: null,
        started_at: "2026-07-01T08:00:00.000Z",
        ended_at: "2026-07-01T09:00:00.000Z",
        distance_meters: null,
      }).distance_state,
    ).toEqual({
      status: "missing",
      reason: "Distance not recorded",
    });
  });

  it("preserves a legacy recorded zero as available", () => {
    expect(
      ActivityRowSchema.parse({
        id: "activity-zero",
        primary_canonical_type: null,
        started_at: "2026-07-01T08:00:00.000Z",
        distance_meters: 0,
      }).distance_state,
    ).toEqual({ status: "available" });
  });
});

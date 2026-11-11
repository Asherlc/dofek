import { describe, expect, it } from "vitest";
import { climbingContextSchema } from "./climbing-context.ts";

const emptyMetadata = {
  areaPath: [],
  climb: null,
  board: null,
  wallAngle: null,
  holdTypes: null,
  providerId: "kaya",
};

describe("climbing context", () => {
  it("retains explicit multiple grips and categorical wall angles", () => {
    expect(
      climbingContextSchema.parse({
        ...emptyMetadata,
        holdTypes: ["crimp", "volume", "jam", "no_grips"],
        wallAngle: { category: "slab" },
      }),
    ).toMatchObject({
      holdTypes: ["crimp", "volume", "jam", "no_grips"],
      wallAngle: { category: "slab" },
    });
  });

  it("preserves an empty source snapshot without supplying missing facts", () => {
    expect(climbingContextSchema.parse({ ...emptyMetadata, providerId: "kaya" })).toEqual({
      ...emptyMetadata,
      providerId: "kaya",
    });
  });

  it("retains every level and nullable source identity in a deep path", () => {
    const areaPath = ["Country", "Region", "District", "Town", "Crag", "Face"].map(
      (name, index) => ({
        id: `00000000-0000-4000-8000-00000000000${index + 1}`,
        userId: "00000000-0000-4000-8000-000000000007",
        providerId: "kaya",
        name,
        externalId: index === 5 ? "face-id" : null,
        parentAreaId: index === 0 ? null : `00000000-0000-4000-8000-00000000000${index}`,
        coordinates: null,
      }),
    );
    expect(climbingContextSchema.parse({ ...emptyMetadata, areaPath }).areaPath).toEqual(areaPath);
  });

  it.each([
    { areaPath: [{ name: " ", externalId: null }] },
    { areaPath: null },
    { climb: { name: "Climb", publishedGrades: [] } },
    { board: { name: "", externalId: null } },
    { board: { name: "Board", externalId: "" } },
    { board: { name: "Board", externalId: null, extra: true } },
    { wallAngle: { value: Number.NaN, unit: null } },
    { wallAngle: { value: Number.POSITIVE_INFINITY, unit: null } },
    { wallAngle: { value: Number.NEGATIVE_INFINITY, unit: null } },
    { wallAngle: { value: 91, unit: "degrees" } },
    { wallAngle: { value: -91, unit: "degrees" } },
    { wallAngle: { value: "40", unit: "degrees" } },
    { wallAngle: { value: 40, unit: "radians" } },
    { wallAngle: { value: 40, unit: null, extra: true } },
    { holdTypes: ["unknown-grip"] },
    { holdTypes: [] },
    { holdTypes: ["crimp", null] },
    { wallAngle: { category: "invented" } },
    { wallAngle: { category: "slab", value: -20, unit: "degrees" } },
  ])("rejects malformed canonical facts: %j", (fields) => {
    expect(climbingContextSchema.safeParse({ ...emptyMetadata, ...fields }).success).toBe(false);
  });

  it.each([-90, 0, 90])("accepts a known degree boundary %s", (value) => {
    expect(
      climbingContextSchema.parse({ ...emptyMetadata, wallAngle: { value, unit: "degrees" } })
        .wallAngle,
    ).toEqual({ value, unit: "degrees" });
  });

  it("retains an unverified angle without applying a degree range", () => {
    expect(
      climbingContextSchema.parse({ ...emptyMetadata, wallAngle: { value: -120, unit: null } })
        .wallAngle,
    ).toEqual({ value: -120, unit: null });
  });

  it("rejects an empty provider namespace", () => {
    expect(climbingContextSchema.safeParse({ ...emptyMetadata, providerId: " " }).success).toBe(
      false,
    );
  });
});

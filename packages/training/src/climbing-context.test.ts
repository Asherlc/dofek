import { describe, expect, it } from "vitest";
import { climbingContextSchema, climbingMetadataSchema } from "./climbing-context.ts";

const emptyMetadata = {
  locationPath: [],
  board: null,
  wallAngle: null,
  climbStyle: null,
  resultStyle: null,
};

describe("climbing context", () => {
  it("preserves an empty source snapshot without supplying missing facts", () => {
    expect(climbingContextSchema.parse({ ...emptyMetadata, providerId: "kaya" })).toEqual({
      ...emptyMetadata,
      providerId: "kaya",
    });
  });

  it("retains every level and nullable source identity in a deep path", () => {
    const locationPath = ["Country", "Region", "District", "Town", "Crag", "Face"].map(
      (name, index) => ({ name, externalId: index === 5 ? "face-id" : null, kind: null }),
    );
    expect(climbingMetadataSchema.parse({ ...emptyMetadata, locationPath }).locationPath).toEqual(
      locationPath,
    );
  });

  it.each([
    { locationPath: [{ name: " ", externalId: null, kind: null }] },
    { locationPath: [{ name: "Crag", externalId: " ", kind: null }] },
    { locationPath: [{ name: "Crag", externalId: null, kind: "region" }] },
    { locationPath: [{ name: "Crag", kind: null }] },
    { locationPath: [{ name: "Crag", externalId: null, kind: null, extra: true }] },
    { locationPath: null },
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
    { climbStyle: "TR" },
    { resultStyle: " " },
  ])("rejects malformed canonical facts: %j", (fields) => {
    expect(climbingMetadataSchema.safeParse({ ...emptyMetadata, ...fields }).success).toBe(false);
  });

  it.each([-90, 0, 90])("accepts a known degree boundary %s", (value) => {
    expect(
      climbingMetadataSchema.parse({ ...emptyMetadata, wallAngle: { value, unit: "degrees" } })
        .wallAngle,
    ).toEqual({ value, unit: "degrees" });
  });

  it("retains an unverified angle without applying a degree range", () => {
    expect(
      climbingMetadataSchema.parse({ ...emptyMetadata, wallAngle: { value: -120, unit: null } })
        .wallAngle,
    ).toEqual({ value: -120, unit: null });
  });

  it.each(["lead", "top-rope", "follow", "solo", "aid"])(
    'accepts recorded method "%s"',
    (climbStyle) => {
      expect(climbingMetadataSchema.parse({ ...emptyMetadata, climbStyle }).climbStyle).toBe(
        climbStyle,
      );
    },
  );

  it.each(["Frenchfree", "A future result"])(
    'preserves unclassified result "%s"',
    (resultStyle) => {
      expect(climbingMetadataSchema.parse({ ...emptyMetadata, resultStyle }).resultStyle).toBe(
        resultStyle,
      );
    },
  );

  it("rejects an empty provider namespace", () => {
    expect(climbingContextSchema.safeParse({ ...emptyMetadata, providerId: " " }).success).toBe(
      false,
    );
  });
});

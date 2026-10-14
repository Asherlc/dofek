import { describe, expect, it } from "vitest";
import {
  areaSchema,
  climbingAttemptSchema,
  climbingLogEntrySchema,
  climbSchema,
} from "./climbing-log.ts";

const owner = {
  id: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  providerId: "summitpost",
  externalId: "object:1234",
};
const summit = {
  ...owner,
  name: "Recorded summit",
  kind: "summit",
  areaId: null,
  grade: null,
  gradeSystem: null,
  setting: null,
  coordinates: null,
};
const attempt = {
  id: "00000000-0000-4000-8000-000000000003",
  climbingLogEntryId: "00000000-0000-4000-8000-000000000004",
  attemptIndex: null,
  outcome: null,
  clean: null,
  receivedBeta: null,
  notes: null,
  createdAt: "2026-10-13T12:00:00Z",
};

describe("climbing log entities", () => {
  it("accepts an undated ungraded summit with unknown attempt facts", () => {
    expect(climbSchema.parse(summit)).toMatchObject({
      kind: "summit",
      grade: null,
      gradeSystem: null,
      setting: null,
    });
    expect(climbingAttemptSchema.parse(attempt)).toMatchObject({
      attemptIndex: null,
      outcome: null,
      clean: null,
      receivedBeta: null,
    });
    expect(
      climbingLogEntrySchema.parse({
        ...owner,
        externalId: "object:1234:log:4567",
        climbId: summit.id,
        activityId: null,
        climbedOn: null,
        discipline: null,
        climbStyle: null,
        title: "Recorded outing",
        notes: null,
        board: null,
        wallAngle: null,
        routeProtection: null,
        holdType: null,
        sourceName: null,
        raw: null,
        providerAbsentAt: null,
        createdAt: "2026-10-13T12:00:00Z",
      }),
    ).toMatchObject({ climbedOn: null, discipline: null, climbId: summit.id });
  });

  it.each([
    ["v_scale", "V4"],
    ["font", "6a"],
    ["yds", "5.10a"],
    ["french", "6a"],
    ["uiaa", "6"],
    ["ewbank", "20"],
    ["saxon", "7a"],
    ["norwegian", "6"],
    ["brazilian_crux", "VI"],
  ])("validates the recognized %s grade system", (gradeSystem, grade) => {
    expect(climbSchema.parse({ ...summit, gradeSystem, grade })).toMatchObject({
      gradeSystem,
      grade,
    });
  });

  it("preserves unknown systems independently of difficulty text", () => {
    expect(climbSchema.parse({ ...summit, grade: "Class 3", gradeSystem: null }).grade).toBe(
      "Class 3",
    );
    expect(climbSchema.safeParse({ ...summit, grade: null, gradeSystem: "yds" }).success).toBe(
      false,
    );
    expect(climbSchema.safeParse({ ...summit, grade: "V4", gradeSystem: "yds" }).success).toBe(
      false,
    );
    expect(climbSchema.safeParse({ ...summit, grade: "", gradeSystem: null }).success).toBe(false);
  });

  it("keeps completion cleanliness and beta as independent recorded facts", () => {
    expect(
      climbingAttemptSchema.parse({ ...attempt, outcome: "completed", clean: null }),
    ).toMatchObject({ outcome: "completed", clean: null });
    expect(climbingAttemptSchema.parse({ ...attempt, clean: false })).toMatchObject({
      outcome: null,
      clean: false,
    });
    expect(
      climbingAttemptSchema.parse({ ...attempt, outcome: "failed", receivedBeta: true }),
    ).toMatchObject({ outcome: "failed", receivedBeta: true });
  });

  it.each([0, -1, 1.5])("rejects an invalid actual attempt index %s", (attemptIndex) => {
    expect(climbingAttemptSchema.safeParse({ ...attempt, attemptIndex }).success).toBe(false);
  });

  it("validates area names and located coordinate pairs", () => {
    expect(
      areaSchema.parse({
        ...owner,
        name: " Recorded region ",
        parentAreaId: null,
        coordinates: { latitude: 0, longitude: 0 },
      }),
    ).toMatchObject({ name: "Recorded region", coordinates: { latitude: 0, longitude: 0 } });
    expect(
      areaSchema.safeParse({ ...owner, name: " ", parentAreaId: null, coordinates: null }).success,
    ).toBe(false);
    expect(climbSchema.safeParse({ ...summit, coordinates: { latitude: 0 } }).success).toBe(false);
  });
});

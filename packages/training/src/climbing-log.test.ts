import { describe, expect, it } from "vitest";
import {
  areaSchema,
  climbingAttemptSchema,
  climbingLogEntrySchema,
  climbSchema,
  gradeComponentSchema,
  isClimbingLogActivity,
  pitchSchema,
  recordedClimbingAttemptSchema,
} from "./climbing-log.ts";

const owner = {
  id: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  providerId: "summitpost",
  externalId: "object:1234",
};

describe("climbing log activity association", () => {
  it.each([
    ["climbing", true],
    ["hiking", true],
    ["running", false],
    ["hangboard", false],
  ])("accepts %s: %s", (kind, eligible) => {
    expect(isClimbingLogActivity(kind)).toBe(eligible);
  });
});
const summit = {
  ...owner,
  name: "Recorded summit",
  kind: "summit",
  areaId: null,
  publishedGrades: [],
  setting: null,
  routeProtection: null,
  coordinates: null,
};
const attempt = {
  id: "00000000-0000-4000-8000-000000000003",
  climbingLogEntryId: "00000000-0000-4000-8000-000000000004",
  scope: "climb",
  pitchId: null,
  parentAttemptId: null,
  attemptIndex: null,
  outcome: null,
  ropeMethod: null,
  solo: null,
  protectionUsed: null,
  usedPreplacedProtection: null,
  usedAid: null,
  fellOrHung: null,
  dabbed: null,
  receivedBeta: null,
  hadCompletedBefore: null,
  priorFailedAttemptsGroundUp: null,
  notes: null,
  createdAt: "2026-10-13T12:00:00Z",
};
const { outcome: _computedOutcome, ...recordedAttemptFields } = attempt;
const recordedAttempt = { ...recordedAttemptFields, sourceResult: null };

describe("recorded climbing attempt source facts", () => {
  it.each(["X", "Flash", " rEdPoInT ", "\tFlash\n", "\u00a0Flash\ufeff"])(
    "preserves the exact original source result %j",
    (sourceResult) => {
      expect(recordedClimbingAttemptSchema.parse({ ...recordedAttempt, sourceResult })).toEqual({
        ...recordedAttempt,
        sourceResult,
      });
    },
  );

  it("accepts an occurrence whose source result was not recorded", () => {
    expect(recordedClimbingAttemptSchema.parse(recordedAttempt)).toEqual(recordedAttempt);
  });

  it.each(["", " ", "\t\n", "\u00a0", "\ufeff", "\u2007", "\u2028"])(
    "rejects an empty or whitespace-only source result %j",
    (sourceResult) => {
      expect(
        recordedClimbingAttemptSchema.safeParse({ ...recordedAttempt, sourceResult }).success,
      ).toBe(false);
    },
  );

  it.each([
    { pitchId: owner.id },
    { parentAttemptId: owner.id },
    { pitchId: owner.id, parentAttemptId: summit.id },
  ])("rejects whole-climb scope with pitch or parent references %j", (references) => {
    expect(
      recordedClimbingAttemptSchema.safeParse({ ...recordedAttempt, ...references }).success,
    ).toBe(false);
  });

  it.each([
    { pitchId: null, parentAttemptId: null },
    { pitchId: owner.id, parentAttemptId: summit.id },
  ])("accepts pitch scope with its recorded references %j", (references) => {
    const scopedAttempt = { ...recordedAttempt, scope: "pitch", ...references };
    expect(recordedClimbingAttemptSchema.parse(scopedAttempt)).toEqual(scopedAttempt);
  });
});

describe("climbing log entities", () => {
  it("accepts an undated ungraded summit with unknown attempt facts", () => {
    expect(climbSchema.parse(summit)).toMatchObject({
      kind: "summit",
      publishedGrades: [],
      setting: null,
    });
    expect(climbingAttemptSchema.parse(attempt)).toMatchObject({
      attemptIndex: null,
      outcome: null,
      fellOrHung: null,
      usedAid: null,
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
        title: "Recorded outing",
        notes: null,
        reportedGrades: [],
        board: null,
        wallAngle: null,
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
    ["british_adjectival", "HVS"],
    ["british_technical", "5a"],
    ["aid", "A3"],
    ["water_ice", "WI4"],
    ["alpine_ice", "AI3"],
    ["mixed", "M6"],
    ["ifas", "TD"],
    ["nccs", "VI"],
  ])("validates a recorded component in the recognized %s system", (system, value) => {
    expect(gradeComponentSchema.parse({ system, value })).toEqual({
      system,
      value,
    });
  });

  it("keeps unknown systems with recorded text", () => {
    expect(gradeComponentSchema.parse({ value: " Class 3 ", system: null })).toEqual({
      value: "Class 3",
      system: null,
    });
    expect(gradeComponentSchema.safeParse({ value: "V4", system: "yds" }).success).toBe(false);
    expect(gradeComponentSchema.safeParse({ value: "5.12a", system: "water_ice" }).success).toBe(
      false,
    );
    expect(gradeComponentSchema.safeParse({ value: " ", system: null }).success).toBe(false);
  });

  it("accepts pitch-only logs and independent attempt facts", () => {
    expect(
      climbingAttemptSchema.parse({
        ...attempt,
        scope: "pitch",
        outcome: "completed",
        usedAid: true,
      }),
    ).toMatchObject({
      scope: "pitch",
      pitchId: null,
      parentAttemptId: null,
      outcome: "completed",
      fellOrHung: null,
      usedAid: true,
    });
    expect(climbingAttemptSchema.parse({ ...attempt, fellOrHung: true })).toMatchObject({
      outcome: null,
      fellOrHung: true,
    });
    expect(
      climbingAttemptSchema.parse({ ...attempt, outcome: "failed", receivedBeta: true }),
    ).toMatchObject({ outcome: "failed", receivedBeta: true });
    expect(
      climbingAttemptSchema.parse({
        ...attempt,
        ropeMethod: "lead",
        solo: true,
        protectionUsed: ["trad"],
        hadCompletedBefore: true,
        priorFailedAttemptsGroundUp: false,
      }),
    ).toMatchObject({
      ropeMethod: "lead",
      solo: true,
      protectionUsed: ["trad"],
      usedAid: null,
      hadCompletedBefore: true,
      priorFailedAttemptsGroundUp: false,
    });
  });

  it("retains multiple published and separately reported grade components", () => {
    expect(
      climbSchema.parse({
        ...summit,
        publishedGrades: [
          { value: "5.12a", system: "yds" },
          { value: "A3", system: "aid" },
        ],
        routeProtection: ["sport"],
      }),
    ).toMatchObject({
      publishedGrades: [
        { value: "5.12a", system: "yds" },
        { value: "A3", system: "aid" },
      ],
      routeProtection: ["sport"],
    });
    expect(
      pitchSchema.parse({
        id: owner.id,
        climbId: summit.id,
        externalId: null,
        number: 2,
        name: null,
        publishedGrades: [
          { value: "HVS", system: "british_adjectival" },
          { value: "5a", system: "british_technical" },
        ],
      }),
    ).toMatchObject({
      number: 2,
      publishedGrades: [
        { value: "HVS", system: "british_adjectival" },
        { value: "5a", system: "british_technical" },
      ],
    });
  });

  it("validates attempt target scope and one-level parent fields", () => {
    expect(climbingAttemptSchema.safeParse({ ...attempt, pitchId: owner.id }).success).toBe(false);
    expect(climbingAttemptSchema.safeParse({ ...attempt, parentAttemptId: owner.id }).success).toBe(
      false,
    );
    expect(
      climbingAttemptSchema.parse({
        ...attempt,
        scope: "pitch",
        pitchId: owner.id,
        parentAttemptId: summit.id,
      }).scope,
    ).toBe("pitch");
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

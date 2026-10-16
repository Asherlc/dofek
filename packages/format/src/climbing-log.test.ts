import type { ClimbingAttempt } from "@dofek/training/climbing-log";
import { describe, expect, it } from "vitest";
import {
  climbingAttemptDetailFields,
  formatClimbingGradeComponents,
  formatClimbingRecordedResult,
  formatClimbingRopeMethods,
  formatGpsCoordinates,
} from "./climbing-log.ts";

function attempt(overrides: Partial<ClimbingAttempt> = {}): ClimbingAttempt {
  return {
    id: "20000000-0000-4000-8000-000000000002",
    climbingLogEntryId: "20000000-0000-4000-8000-000000000001",
    scope: "climb",
    outcome: null,
    ropeMethod: null,
    solo: null,
    usedAid: null,
    fellOrHung: null,
    pitchId: null,
    parentAttemptId: null,
    attemptIndex: null,
    protectionUsed: null,
    usedPreplacedProtection: null,
    dabbed: null,
    receivedBeta: null,
    hadCompletedBefore: null,
    priorFailedAttemptsGroundUp: null,
    notes: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("climbing log formatting", () => {
  it("preserves every advertised grade component and its recorded system", () => {
    expect(
      formatClimbingGradeComponents([
        { value: "5.10a", system: "yds" },
        { value: "A1", system: "aid" },
        { value: "Source text", system: null },
      ]),
    ).toBe("5.10a (Yosemite Decimal System) · A1 (Aid) · Source text (Scale unknown)");
  });
  it("renders latitude and longitude including zero without changing their order", () => {
    expect(formatGpsCoordinates({ latitude: 37.5, longitude: -122.25 })).toBe("37.5, −122.25");
    expect(formatGpsCoordinates({ latitude: 0, longitude: 0 })).toBe("0, 0");
    expect(formatGpsCoordinates({ latitude: 1e-7, longitude: -1e-7 })).toBe("1e-7, −1e-7");
  });
  it("describes a scoped result and pluralizes its recorded occurrences", () => {
    expect(formatClimbingRecordedResult("Whole climb", "completed", 1)).toBe(
      "Whole climb completed · 1 recorded attempt",
    );
    expect(formatClimbingRecordedResult("Pitch", "failed", 3)).toBe(
      "Pitch failed · 3 recorded attempts",
    );
    expect(formatClimbingRecordedResult("Whole climb", null, 2)).toBe(
      "Whole climb · 2 recorded attempts",
    );
    expect(formatClimbingRecordedResult("Pitch 1", null, 1)).toBe("Pitch 1 · 1 recorded attempt");
  });
  it("labels each recorded rope method once without exposing unreported methods", () => {
    expect(formatClimbingRopeMethods([{ ropeMethod: "top_rope" }])).toBe("Top rope");
    expect(
      formatClimbingRopeMethods([
        { ropeMethod: "lead" },
        { ropeMethod: null },
        { ropeMethod: "top_rope" },
        { ropeMethod: "lead" },
        { ropeMethod: "follow" },
        { ropeMethod: "unroped" },
      ]),
    ).toBe("Lead · Top rope · Follow · Unroped");
    expect(formatClimbingRopeMethods([{ ropeMethod: null }])).toBeNull();
    expect(formatClimbingRopeMethods([])).toBeNull();
  });
  it("lists every unknown fact without turning missing evidence into false", () => {
    expect(climbingAttemptDetailFields(attempt())).toEqual([
      { label: "Scope", value: "Whole climb" },
      { label: "Outcome", value: "Not reported by source" },
      { label: "Attempt order", value: "Unknown" },
      { label: "Rope method", value: "Unknown" },
      { label: "Solo", value: "Unknown" },
      { label: "Protection used", value: "Unknown" },
      { label: "Used preplaced protection", value: "Unknown" },
      { label: "Used aid", value: "Unknown" },
      { label: "Fell or hung", value: "Unknown" },
      { label: "Dabbed", value: "Unknown" },
      { label: "Received beta", value: "Unknown" },
      { label: "Had completed before", value: "Unknown" },
      { label: "Prior failed attempts from the ground", value: "Unknown" },
      { label: "Pitch reference", value: "None" },
      { label: "Parent attempt reference", value: "None" },
    ]);
  });
  it.each([true, false])("renders independently reported boolean facts as %s", (value) => {
    const fields = climbingAttemptDetailFields(
      attempt({
        solo: value,
        usedPreplacedProtection: value,
        usedAid: value,
        fellOrHung: value,
        dabbed: value,
        receivedBeta: value,
        hadCompletedBefore: value,
        priorFailedAttemptsGroundUp: value,
      }),
    );
    for (const label of [
      "Solo",
      "Used preplaced protection",
      "Used aid",
      "Fell or hung",
      "Dabbed",
      "Received beta",
      "Had completed before",
      "Prior failed attempts from the ground",
    ]) {
      expect(fields.find((field) => field.label === label)).toEqual({
        label,
        value: value ? "Yes" : "No",
      });
    }
  });
  it("preserves known pitch, parent, order, outcome and protection facts", () => {
    const fields = climbingAttemptDetailFields(
      attempt({
        scope: "pitch",
        outcome: "failed",
        pitchId: "pitch-id",
        parentAttemptId: "whole-attempt-id",
        attemptIndex: 4,
        protectionUsed: ["sport", "trad"],
      }),
    );
    expect(fields).toEqual(
      expect.arrayContaining([
        { label: "Scope", value: "Pitch" },
        { label: "Outcome", value: "Failed" },
        { label: "Attempt order", value: "4" },
        { label: "Protection used", value: "Sport, Trad" },
        { label: "Pitch reference", value: "pitch-id" },
        { label: "Parent attempt reference", value: "whole-attempt-id" },
      ]),
    );
    expect(climbingAttemptDetailFields(attempt({ protectionUsed: [] }))).toContainEqual({
      label: "Protection used",
      value: "None recorded",
    });
    expect(climbingAttemptDetailFields(attempt({ scope: "pitch" }))).toContainEqual({
      label: "Pitch reference",
      value: "Unidentified",
    });
  });
  it("labels independent method, solo, aid, and interruption facts without deriving a send", () => {
    const attempt: ClimbingAttempt = {
      id: "20000000-0000-4000-8000-000000000002",
      climbingLogEntryId: "20000000-0000-4000-8000-000000000001",
      scope: "pitch",
      outcome: "completed",
      ropeMethod: "lead",
      solo: true,
      usedAid: true,
      fellOrHung: null,
      pitchId: null,
      parentAttemptId: null,
      attemptIndex: null,
      protectionUsed: null,
      usedPreplacedProtection: null,
      dabbed: null,
      receivedBeta: null,
      hadCompletedBefore: null,
      priorFailedAttemptsGroundUp: null,
      notes: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    expect(climbingAttemptDetailFields(attempt)).toEqual(
      expect.arrayContaining([
        { label: "Outcome", value: "Completed" },
        { label: "Rope method", value: "Lead" },
        { label: "Solo", value: "Yes" },
        { label: "Used aid", value: "Yes" },
        { label: "Fell or hung", value: "Unknown" },
        { label: "Attempt order", value: "Unknown" },
      ]),
    );
  });
});

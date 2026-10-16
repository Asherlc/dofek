import type { ClimbingAttempt } from "@dofek/training/climbing-log";
import { describe, expect, it } from "vitest";
import {
  climbingAttemptDetailFields,
  formatClimbingGradeComponents,
  formatClimbingRecordedResult,
  formatClimbingRopeMethods,
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
  it("describes a scoped result and labels its attempt count", () => {
    expect(formatClimbingRecordedResult("Whole climb", "completed", 1)).toBe(
      "Whole climb completed · Attempts: 1",
    );
    expect(formatClimbingRecordedResult("Pitch", "failed", 3)).toBe("Pitch failed · Attempts: 3");
    expect(formatClimbingRecordedResult("Whole climb", null, 2)).toBe("Whole climb · Attempts: 2");
    expect(formatClimbingRecordedResult("Pitch 1", null, 1)).toBe("Pitch 1 · Attempts: 1");
  });
  it("renders the outcome and attempt count when the target is implicit", () => {
    expect(formatClimbingRecordedResult(null, null, 1)).toBe("Attempts: 1");
    expect(formatClimbingRecordedResult(null, "completed", 2)).toBe("Completed · Attempts: 2");
    expect(formatClimbingRecordedResult(null, "failed", 1)).toBe("Failed · Attempts: 1");
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
  it("preserves known outcome and protection facts", () => {
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
    expect(fields).toEqual([
      { label: "Outcome", value: "Failed" },
      { label: "Protection used", value: "Sport, Trad" },
    ]);
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
      ]),
    );
  });
});

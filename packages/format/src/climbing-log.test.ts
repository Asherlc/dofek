import type { ClimbingAttempt } from "@dofek/training/climbing-log";
import { describe, expect, it } from "vitest";
import {
  climbingAttemptDetailFields,
  formatClimbingGradeComponents,
  formatGpsCoordinates,
} from "./climbing-log.ts";

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

import type { ClimbingAttempt } from "@dofek/training/climbing-log";
import type { ClimbingProjectHistory } from "@dofek/training/climbing-project-history";
import { describe, expect, it } from "vitest";
import {
  climbingAttemptDetailFields,
  climbingAttemptStyleLabels,
  formatClimbingGradeComponents,
  formatClimbingProjectDay,
  formatClimbingProjectHistory,
  formatClimbingRecordedResult,
  formatClimbingResultOutcome,
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
  it.each([
    { ropeMethod: "lead", expected: [["Lead", "Fell/Hung"]] },
    { ropeMethod: "top_rope", expected: [["Top rope", "Fell/Hung"]] },
    { ropeMethod: "follow", expected: [["Follow", "Fell/Hung"]] },
    { ropeMethod: null, expected: [["Fell/Hung"]] },
  ] as const)("retains fall/hang evidence for $ropeMethod", ({ ropeMethod, expected }) => {
    expect(climbingAttemptStyleLabels([attempt({ ropeMethod, fellOrHung: true })])).toEqual(
      expected,
    );
  });

  it("keeps fall/hang evidence attached to its recorded method", () => {
    expect(
      climbingAttemptStyleLabels([
        attempt({ ropeMethod: "lead", fellOrHung: true }),
        attempt({ ropeMethod: "lead", fellOrHung: true }),
        attempt({ ropeMethod: "top_rope", fellOrHung: false }),
        attempt({ ropeMethod: "top_rope", fellOrHung: true }),
      ]),
    ).toEqual([["Lead", "Fell/Hung"], ["Top rope"], ["Top rope", "Fell/Hung"]]);
  });

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
      "Whole climb · Completed · Attempts: 1",
    );
    expect(formatClimbingRecordedResult("Pitch", "failed", 3)).toBe(
      "Pitch · Attempted · Attempts: 3",
    );
    expect(formatClimbingRecordedResult("Whole climb", null, 2)).toBe("Whole climb · Attempts: 2");
    expect(formatClimbingRecordedResult("Pitch 1", null, 1)).toBe("Pitch 1 · Attempts: 1");
  });
  it("renders the outcome and attempt count when the target is implicit", () => {
    expect(formatClimbingRecordedResult(null, null, 1)).toBe("Attempts: 1");
    expect(formatClimbingRecordedResult(null, "completed", 2)).toBe("Completed · Attempts: 2");
    expect(formatClimbingRecordedResult(null, "failed", 1)).toBe("Attempted · Attempts: 1");
  });
  it("preserves recorded results without inventing an unknown attempt count", () => {
    expect(formatClimbingRecordedResult(null, "completed", null)).toBe("Completed");
    expect(formatClimbingRecordedResult(null, "failed", null)).toBe("Attempted");
    expect(formatClimbingRecordedResult("Pitch 1", "completed", null)).toBe("Pitch 1 · Completed");
    expect(formatClimbingRecordedResult("Pitch 1", null, null)).toBe("Pitch 1");
    expect(formatClimbingRecordedResult(null, null, null)).toBeNull();
  });
  it.each([
    { outcome: "completed", label: "Completed" },
    { outcome: "failed", label: "Attempted" },
  ] as const)("distinguishes a non-send's $outcome outcome", ({ outcome, label }) => {
    expect(formatClimbingRecordedResult(null, outcome, 2, [], false)).toBe(
      `${label} · Attempts: 2`,
    );
    expect(formatClimbingRecordedResult(null, outcome, null, [], false)).toBe(label);
  });
  it("keeps confirmed sends concise", () => {
    expect(formatClimbingRecordedResult(null, "completed", 2, ["sent"], true)).toBe("Attempts: 2");
    expect(formatClimbingRecordedResult(null, "completed", null, ["sent"], true)).toBeNull();
  });
  it.each([false, null])("preserves unknown completion for send status %s", (freeSend) => {
    expect(formatClimbingRecordedResult(null, null, 2, [], freeSend)).toBe("Attempts: 2");
    expect(formatClimbingRecordedResult(null, null, null, [], freeSend)).toBeNull();
  });
  it("labels each recorded rope method once without exposing unreported methods", () => {
    expect(climbingAttemptStyleLabels([attempt({ ropeMethod: "top_rope" })])).toEqual([
      ["Top rope"],
    ]);
    expect(
      climbingAttemptStyleLabels([
        attempt({ ropeMethod: "lead" }),
        attempt({ ropeMethod: null }),
        attempt({ ropeMethod: "top_rope" }),
        attempt({ ropeMethod: "lead" }),
        attempt({ ropeMethod: "follow" }),
        attempt({ ropeMethod: "unroped" }),
      ]),
    ).toEqual([["Lead"], ["Top rope"], ["Follow"], ["Unroped"]]);
    expect(climbingAttemptStyleLabels([attempt({ ropeMethod: null })])).toEqual([]);
    expect(climbingAttemptStyleLabels([])).toEqual([]);
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

it.each(["Onsight", "Flash"])("omits the redundant attempts count for %s", (label) => {
  expect(formatClimbingRecordedResult(null, "completed", 1, ["sent", label])).toBeNull();
  expect(formatClimbingRecordedResult("Pitch 1", "completed", 1, [label])).toBe("Pitch 1");
});

function history(overrides: Partial<ClimbingProjectHistory> = {}): ClimbingProjectHistory {
  return {
    throughDate: "2026-11-13",
    sessionCount: 3,
    unsuccessfulSessionCount: 2,
    unknownSessionCount: 1,
    firstSend: null,
    methodFirstSend: null,
    repeatBeforeFirstSend: false,
    earlierSessionsUnknown: false,
    days: [],
    ...overrides,
  };
}

describe("formatClimbingProjectHistory", () => {
  it("summarizes an unconfirmed project with singular and plural counts", () => {
    expect(formatClimbingProjectHistory(history())).toEqual({
      summary: "3 logged sessions · Send unconfirmed",
      detail: "2 unsuccessful · 1 result unknown",
      methodDetail: null,
    });
    expect(
      formatClimbingProjectHistory(
        history({ sessionCount: 1, unknownSessionCount: 2, unsuccessfulSessionCount: 0 }),
      ),
    ).toEqual({
      summary: "1 logged session · Send unconfirmed",
      detail: "0 unsuccessful · 2 results unknown",
      methodDetail: null,
    });
  });

  it("says the first send date is unknown when only repeats were logged", () => {
    expect(formatClimbingProjectHistory(history({ repeatBeforeFirstSend: true })).summary).toBe(
      "3 logged sessions · First send date unknown",
    );
  });

  it("describes a first send with its method, date and unknown earlier sessions", () => {
    const firstSend = { date: "2026-11-09", sessionCount: 2, method: "top_rope" as const };
    const result = formatClimbingProjectHistory(history({ firstSend }));
    expect(result.summary).toBe("2 logged sessions to first recorded send");
    expect(result.detail).toBe("Top rope · Nov 9");
    expect(result.methodDetail).toBeNull();
    expect(
      formatClimbingProjectHistory(
        history({
          firstSend: { ...firstSend, sessionCount: 1, method: null },
          earlierSessionsUnknown: true,
        }),
      ),
    ).toMatchObject({
      summary: "1 logged session to first recorded send",
      detail: "Nov 9 · Earlier sessions unknown",
    });
  });

  it("omits method detail when the method send is the same milestone", () => {
    const firstSend = { date: "2026-11-09", sessionCount: 2, method: "lead" as const };
    expect(
      formatClimbingProjectHistory(history({ firstSend, methodFirstSend: { ...firstSend } }))
        .methodDetail,
    ).toBeNull();
  });

  it.each([
    ["date", { date: "2026-11-13" }],
    ["session count", { sessionCount: 3 }],
    ["method", { method: "top_rope" as const }],
  ])("shows a separate method milestone when its %s differs", (_name, change) => {
    const firstSend = { date: "2026-11-09", sessionCount: 1, method: "lead" as const };
    expect(
      formatClimbingProjectHistory(
        history({ firstSend, methodFirstSend: { ...firstSend, ...change } }),
      ).methodDetail,
    ).toMatch(/^First recorded .+ send after \d .+ sessions? · Nov \d+$/);
  });

  it("shows a method milestone when no overall send exists", () => {
    expect(
      formatClimbingProjectHistory(
        history({ methodFirstSend: { date: "2026-11-13", sessionCount: 1, method: "lead" } }),
      ).methodDetail,
    ).toBe("First recorded lead send after 1 lead session · Nov 13");
  });
});

describe("formatClimbingProjectDay", () => {
  it.each([
    [{ date: "2026-11-09", outcome: "send", method: "lead" }, "Lead · Sent"],
    [{ date: "2026-11-09", outcome: "unsuccessful", method: null }, "Unsuccessful"],
    [{ date: "2026-11-09", outcome: "unknown", method: "top_rope" }, "Top rope · Result unknown"],
  ] as const)("formats %j", (day, expected) => {
    expect(formatClimbingProjectDay(day)).toBe(expected);
  });
});

describe("formatClimbingResultOutcome", () => {
  it("labels failed and plain completed outcomes", () => {
    expect(formatClimbingResultOutcome("failed")).toBe("Attempted");
    expect(formatClimbingResultOutcome("failed", ["Flash"], true)).toBe("Attempted");
    expect(formatClimbingResultOutcome("completed")).toBe("Completed");
    expect(formatClimbingResultOutcome("completed", [], false)).toBe("Completed");
  });

  it("leaves outcomes that other labels already describe unlabelled", () => {
    expect(formatClimbingResultOutcome("completed", [], true)).toBeNull();
    expect(formatClimbingResultOutcome("completed", ["Redpoint"])).toBeNull();
    expect(formatClimbingResultOutcome(null)).toBeNull();
  });
});

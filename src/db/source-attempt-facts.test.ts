import { describe, expect, it } from "vitest";
import { normalizeSourceAttemptFacts } from "./source-attempt-facts.ts";

const target = {
  climbKind: "route",
  targetIdentified: true,
  hasOtherTargetHistory: false,
} as const;

describe("source attempt evidence", () => {
  it("normalizes free Onsight into independent completion execution beta and first try", () => {
    expect(normalizeSourceAttemptFacts({}, "free-onsight", target)).toEqual({
      outcome: "completed",
      fellOrHung: false,
      usedAid: false,
      receivedBeta: false,
      attemptIndex: 1,
    });
  });

  it("retains aid first-try completion without inventing falls or hangs", () => {
    expect(normalizeSourceAttemptFacts({}, "aid-onsight", target)).toEqual({
      outcome: "completed",
      usedAid: true,
      receivedBeta: false,
      attemptIndex: 1,
    });
    expect(normalizeSourceAttemptFacts({ fellOrHung: true }, "aid-flash", target)).toEqual({
      outcome: "completed",
      usedAid: true,
      fellOrHung: true,
      receivedBeta: true,
      attemptIndex: 1,
    });
  });

  it("uses Flash beta only without other history on its identified target", () => {
    expect(normalizeSourceAttemptFacts({}, "free-flash", target)).toEqual({
      outcome: "completed",
      fellOrHung: false,
      usedAid: false,
      receivedBeta: true,
      attemptIndex: 1,
    });
    expect(
      normalizeSourceAttemptFacts({}, "free-flash", { ...target, hasOtherTargetHistory: true }),
    ).toEqual({ outcome: "completed", fellOrHung: false, usedAid: false, attemptIndex: 1 });
    expect(
      normalizeSourceAttemptFacts({}, "aid-flash", { ...target, hasOtherTargetHistory: true }),
    ).toEqual({ outcome: "completed", usedAid: true, attemptIndex: 1 });
  });

  it("preserves separately supplied beta when history cannot supply it", () => {
    expect(
      normalizeSourceAttemptFacts({ receivedBeta: true }, "free-flash", {
        ...target,
        hasOtherTargetHistory: true,
      }),
    ).toEqual({
      outcome: "completed",
      fellOrHung: false,
      usedAid: false,
      receivedBeta: true,
      attemptIndex: 1,
    });
  });

  it("keeps unidentified pitch order and conditional Flash beta unknown", () => {
    expect(
      normalizeSourceAttemptFacts({}, "free-flash", { ...target, targetIdentified: false }),
    ).toEqual({ outcome: "completed", fellOrHung: false, usedAid: false });
  });

  it("records free sends without assigning actual order or beta", () => {
    expect(normalizeSourceAttemptFacts({ attemptIndex: 4 }, "free-send", target)).toEqual({
      outcome: "completed",
      fellOrHung: false,
      usedAid: false,
      attemptIndex: 4,
    });
    expect(normalizeSourceAttemptFacts({ outcome: null }, "free-send", target)).toEqual({
      outcome: "completed",
      fellOrHung: false,
      usedAid: false,
    });
  });

  it("distinguishes boulder sends from completed dabs", () => {
    expect(
      normalizeSourceAttemptFacts({}, "free-send", { ...target, climbKind: "boulder" }),
    ).toEqual({ outcome: "completed", fellOrHung: false, usedAid: false, dabbed: false });
    expect(normalizeSourceAttemptFacts({}, "dab", { ...target, climbKind: "boulder" })).toEqual({
      outcome: "completed",
      dabbed: true,
    });
  });

  it.each([undefined, "completed", "failed"] as const)(
    "retains Fell/Hung independently of outcome %s",
    (outcome) => {
      const supplied = outcome === undefined ? {} : { outcome };
      expect(normalizeSourceAttemptFacts(supplied, "fell-hung", target)).toEqual({
        ...supplied,
        fellOrHung: true,
      });
    },
  );

  it("retains independent solo aid protection and history evidence", () => {
    const supplied = {
      ropeMethod: "lead",
      solo: true,
      usedAid: true,
      protectionUsed: ["trad"],
      usedPreplacedProtection: false,
      hadCompletedBefore: true,
      priorFailedAttemptsGroundUp: false,
    } as const;
    expect(
      normalizeSourceAttemptFacts({ ...supplied, protectionUsed: ["trad"] }, undefined, target),
    ).toEqual(supplied);
    expect(
      normalizeSourceAttemptFacts({ ropeMethod: "top_rope", solo: true }, undefined, target),
    ).toEqual({ ropeMethod: "top_rope", solo: true });
  });

  it("retains summit outcomes without inventing rock execution facts", () => {
    expect(
      normalizeSourceAttemptFacts({ outcome: "completed" }, undefined, {
        ...target,
        climbKind: "summit",
      }),
    ).toEqual({ outcome: "completed" });
    expect(
      normalizeSourceAttemptFacts({ outcome: "failed" }, undefined, {
        ...target,
        climbKind: "summit",
      }),
    ).toEqual({ outcome: "failed" });
  });

  it("preserves omissions nulls and notes independently of qualifiers", () => {
    expect(normalizeSourceAttemptFacts({}, undefined, target)).toEqual({});
    expect(
      normalizeSourceAttemptFacts({ fellOrHung: null, notes: null }, undefined, target),
    ).toEqual({ fellOrHung: null, notes: null });
    expect(normalizeSourceAttemptFacts({ notes: "Recorded note" }, "free-onsight", target)).toEqual(
      {
        outcome: "completed",
        fellOrHung: false,
        usedAid: false,
        receivedBeta: false,
        attemptIndex: 1,
        notes: "Recorded note",
      },
    );
  });

  it("rejects conflicting explicit facts without overwriting them", () => {
    expect(() =>
      normalizeSourceAttemptFacts({ outcome: "failed" }, "free-onsight", target),
    ).toThrow("outcome");
    expect(() => normalizeSourceAttemptFacts({ fellOrHung: false }, "fell-hung", target)).toThrow(
      "fellOrHung",
    );
    expect(() => normalizeSourceAttemptFacts({ usedAid: true }, "free-send", target)).toThrow(
      "usedAid",
    );
    expect(() => normalizeSourceAttemptFacts({ attemptIndex: 3 }, "free-flash", target)).toThrow(
      "attemptIndex",
    );
    expect(() =>
      normalizeSourceAttemptFacts({ receivedBeta: true }, "free-onsight", target),
    ).toThrow("receivedBeta");
  });
});

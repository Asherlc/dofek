import { describe, expect, it } from "vitest";
import {
  type ClimbingProjectObservation,
  summarizeClimbingProjectHistory,
} from "./climbing-project-history.ts";

function observation(
  date: string,
  outcome: ClimbingProjectObservation["outcome"],
  options: Partial<ClimbingProjectObservation> = {},
): ClimbingProjectObservation {
  return {
    date,
    outcome,
    method: null,
    repeat: false,
    earlierAttempts: false,
    described: true,
    selected: false,
    ...options,
  };
}

describe("summarizeClimbingProjectHistory", () => {
  it("counts distinct project days and the first send in the selected rope method", () => {
    const history = summarizeClimbingProjectHistory("2026-11-13", [
      observation("2026-11-13", "unsuccessful", { method: "lead" }),
      observation("2026-11-09", "send", { method: "top_rope" }),
      observation("2026-11-06", "unsuccessful", { method: "lead" }),
      observation("2026-11-11", "unsuccessful", { method: "lead" }),
      observation("2026-11-13", "send", { method: "lead", selected: true }),
    ]);
    expect(history.sessionCount).toBe(4);
    expect(history.firstSend).toEqual({ date: "2026-11-09", method: "top_rope", sessionCount: 2 });
    expect(history.methodFirstSend).toEqual({
      date: "2026-11-13",
      method: "lead",
      sessionCount: 3,
    });
  });

  it("distinguishes independently unknown results from anonymous counted attempts", () => {
    const history = summarizeClimbingProjectHistory("2026-11-12", [
      observation("2026-11-04", "unsuccessful"),
      observation("2026-11-04", "unknown", { described: false }),
      observation("2026-11-12", "unsuccessful"),
      observation("2026-11-12", "unknown"),
    ]);
    expect(history.days.map((day) => day.outcome)).toEqual(["unsuccessful", "unknown"]);
    expect(history.firstSend).toBeNull();
  });

  it("uses an explicitly recorded method on a selected day with no reported result", () => {
    const history = summarizeClimbingProjectHistory("2026-11-13", [
      observation("2026-11-06", "send", { method: "top_rope" }),
      observation("2026-11-09", "send", { method: "lead" }),
      observation("2026-11-13", "unknown", { method: "lead", selected: true, described: false }),
    ]);
    expect(history.methodFirstSend).toEqual({
      date: "2026-11-09",
      method: "lead",
      sessionCount: 1,
    });
  });

  it("keeps prior history unknown for repeat-only logs and a redpoint on the first logged day", () => {
    const repeat = summarizeClimbingProjectHistory("2026-11-13", [
      observation("2026-11-09", "send", { repeat: true }),
      observation("2026-11-13", "send"),
    ]);
    expect(repeat.repeatBeforeFirstSend).toBe(true);
    expect(repeat.firstSend).toBeNull();
    const redpoint = summarizeClimbingProjectHistory("2026-11-13", [
      observation("2026-11-13", "send", { earlierAttempts: true }),
    ]);
    expect(redpoint.firstSend?.sessionCount).toBe(1);
    expect(redpoint.earlierSessionsUnknown).toBe(true);
  });
});

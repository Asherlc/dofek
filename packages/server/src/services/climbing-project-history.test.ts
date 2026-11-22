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

  it("orders days chronologically and reports session counts by outcome", () => {
    const history = summarizeClimbingProjectHistory("2026-11-13", [
      observation("2026-11-13", "unknown", { described: false }),
      observation("2026-11-02", "unsuccessful"),
      observation("2026-11-09", "send"),
      observation("2026-11-06", "unknown"),
    ]);
    expect(history.throughDate).toBe("2026-11-13");
    expect(history.days.map((day) => [day.date, day.outcome])).toEqual([
      ["2026-11-02", "unsuccessful"],
      ["2026-11-06", "unknown"],
      ["2026-11-09", "send"],
      ["2026-11-13", "unknown"],
    ]);
    expect(history).toMatchObject({
      sessionCount: 4,
      unsuccessfulSessionCount: 1,
      unknownSessionCount: 2,
      repeatBeforeFirstSend: false,
      earlierSessionsUnknown: false,
    });
    expect(history.firstSend).toEqual({ date: "2026-11-09", method: null, sessionCount: 3 });
  });

  it("counts a send as the day's outcome even when failures were also logged", () => {
    const history = summarizeClimbingProjectHistory("2026-11-09", [
      observation("2026-11-09", "unsuccessful", { method: "lead" }),
      observation("2026-11-09", "send", { method: "lead" }),
    ]);
    expect(history.days).toEqual([{ date: "2026-11-09", outcome: "send", method: "lead" }]);
    expect(history.firstSend?.sessionCount).toBe(1);
    expect(history.unsuccessfulSessionCount).toBe(0);
  });

  it("leaves the day's method unknown when its sends used different methods", () => {
    const history = summarizeClimbingProjectHistory("2026-11-09", [
      observation("2026-11-09", "send", { method: "lead" }),
      observation("2026-11-09", "send", { method: "top_rope" }),
    ]);
    expect(history.days[0]?.method).toBeNull();
  });

  it("uses described attempts for the method of a day without a send", () => {
    const history = summarizeClimbingProjectHistory("2026-11-09", [
      observation("2026-11-09", "unsuccessful", { method: "lead" }),
      observation("2026-11-09", "unknown", { method: "top_rope", described: false }),
    ]);
    expect(history.days).toEqual([{ date: "2026-11-09", outcome: "unsuccessful", method: "lead" }]);
  });

  it("treats a described unknown result as ambiguous rather than unsuccessful", () => {
    const history = summarizeClimbingProjectHistory("2026-11-09", [
      observation("2026-11-09", "unsuccessful"),
      observation("2026-11-09", "unknown"),
    ]);
    expect(history.days[0]?.outcome).toBe("unknown");
  });

  it("flags repeat sends as the first send only when every send that day is a repeat", () => {
    const mixed = summarizeClimbingProjectHistory("2026-11-09", [
      observation("2026-11-09", "send", { repeat: true }),
      observation("2026-11-09", "send"),
    ]);
    expect(mixed.repeatBeforeFirstSend).toBe(false);
    expect(mixed.firstSend?.sessionCount).toBe(1);
  });

  it("only reports earlier unknown sessions for a first-day send with earlier attempts", () => {
    const laterSend = summarizeClimbingProjectHistory("2026-11-13", [
      observation("2026-11-09", "unsuccessful"),
      observation("2026-11-13", "send", { earlierAttempts: true }),
    ]);
    expect(laterSend.earlierSessionsUnknown).toBe(false);
    const plain = summarizeClimbingProjectHistory("2026-11-13", [
      observation("2026-11-13", "send"),
    ]);
    expect(plain.earlierSessionsUnknown).toBe(false);
    const earlierOnDifferentDay = summarizeClimbingProjectHistory("2026-11-13", [
      observation("2026-11-09", "send", { earlierAttempts: true }),
      observation("2026-11-13", "send"),
    ]);
    expect(earlierOnDifferentDay.earlierSessionsUnknown).toBe(true);
  });

  it("derives the selected method only from described or explicitly methoded selections", () => {
    const base = [observation("2026-11-09", "send", { method: "lead" })];
    const anonymous = summarizeClimbingProjectHistory("2026-11-13", [
      ...base,
      observation("2026-11-13", "unknown", { selected: true, described: false }),
    ]);
    expect(anonymous.methodFirstSend).toBeNull();
    const mixedMethods = summarizeClimbingProjectHistory("2026-11-13", [
      ...base,
      observation("2026-11-13", "send", { method: "lead", selected: true }),
      observation("2026-11-13", "send", { method: "top_rope", selected: true }),
    ]);
    expect(mixedMethods.methodFirstSend).toBeNull();
    const unselected = summarizeClimbingProjectHistory("2026-11-13", [
      observation("2026-11-13", "send", { method: "lead" }),
    ]);
    expect(unselected.methodFirstSend).toBeNull();
    const noMethodSend = summarizeClimbingProjectHistory("2026-11-13", [
      observation("2026-11-13", "unsuccessful", { method: "lead", selected: true }),
    ]);
    expect(noMethodSend.methodFirstSend).toBeNull();
  });
});

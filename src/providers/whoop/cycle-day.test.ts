import { describe, expect, it } from "vitest";
import { normalizeWhoopDay, resolveWhoopCycleDay } from "./cycle-day.ts";

describe("normalizeWhoopDay", () => {
  it.each(["2026-02-30", "2026-03", "0", "not-a-date"])(
    "rejects malformed or shorthand date %s",
    (value) => {
      expect(normalizeWhoopDay(value)).toBeNull();
    },
  );

  it.each([
    ["2026-03-11", "2026-03-11"],
    ["2026-03-11T08:00:00.000Z", "2026-03-11"],
    ["2026-03-11T01:00:00-07:00", "2026-03-11"],
    [new Date("2026-03-11T08:00:00.000Z"), "2026-03-11"],
  ])("normalizes supported ISO value %s to %s", (value, expected) => {
    expect(normalizeWhoopDay(value)).toBe(expected);
  });

  it("rejects an invalid Date object", () => {
    expect(normalizeWhoopDay(new Date(Number.NaN))).toBeNull();
  });
});

describe("resolveWhoopCycleDay", () => {
  it("uses a valid recovery timestamp before the caller fallback", () => {
    expect(
      resolveWhoopCycleDay(
        {
          recovery: {
            user_id: 123,
            created_at: "2026-03-11T08:00:00.000Z",
            updated_at: "2026-03-11T08:00:00.000Z",
          },
        },
        "2026-03-12T08:00:00.000Z",
      ),
    ).toBe("2026-03-11");
  });

  it("uses the caller fallback when recovery is absent", () => {
    expect(resolveWhoopCycleDay({}, "2026-03-12T08:00:00.000Z")).toBe("2026-03-12");
  });

  it("throws when every date candidate is invalid", () => {
    expect(() =>
      resolveWhoopCycleDay(
        {
          days: ["2026-02-30"],
          recovery: {
            user_id: 123,
            created_at: "2026-03",
            updated_at: "2026-03-11T08:00:00.000Z",
          },
        },
        "not-a-date",
      ),
    ).toThrow("WHOOP cycle has no valid date");
  });
});

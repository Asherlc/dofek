import { describe, expect, it } from "vitest";
import {
  parseTimeRangePreference,
  serializeTimeRangePreference,
  TIME_RANGE_POLICIES,
  timeRangePreferenceKey,
} from "./time-range.ts";

describe("time range policy", () => {
  it("defines domain-appropriate defaults with user-facing explanations", () => {
    expect(TIME_RANGE_POLICIES).toEqual({
      body: {
        defaultDays: 30,
        description: "Recommended default: 30 days keeps recent body changes visible.",
      },
      recovery: {
        defaultDays: 30,
        description: "Recommended default: 30 days keeps recent recovery changes visible.",
      },
      sleep: {
        defaultDays: 30,
        description: "Recommended default: 30 days keeps recent sleep patterns visible.",
      },
      training: {
        defaultDays: 90,
        description:
          "Recommended default: 90 days balances recent training changes with enough history.",
      },
      nutrition: {
        defaultDays: 90,
        description:
          "Recommended default: 90 days provides enough intake and weight history for stable trends.",
      },
      behavior: {
        defaultDays: 90,
        description:
          "Recommended default: 90 days provides enough journal observations to compare patterns.",
      },
      correlation: {
        defaultDays: 365,
        description:
          "Recommended default: 1 year provides enough paired observations for longer-term relationships.",
      },
    });
  });

  it("uses one stable persistence key per related domain", () => {
    expect(timeRangePreferenceKey("body")).toBe("dofek.time-range.body");
    expect(timeRangePreferenceKey("recovery")).toBe("dofek.time-range.recovery");
    expect(timeRangePreferenceKey("sleep")).toBe("dofek.time-range.sleep");
    expect(timeRangePreferenceKey("training")).toBe("dofek.time-range.training");
    expect(timeRangePreferenceKey("nutrition")).toBe("dofek.time-range.nutrition");
    expect(timeRangePreferenceKey("behavior")).toBe("dofek.time-range.behavior");
    expect(timeRangePreferenceKey("correlation")).toBe("dofek.time-range.correlation");
  });

  it("round-trips finite and all-history selections", () => {
    expect(serializeTimeRangePreference(90)).toBe("90");
    expect(serializeTimeRangePreference(null)).toBe("all");
    for (const days of [7, 14, 30, 90, 180, 365]) {
      expect(parseTimeRangePreference(String(days), 30)).toBe(days);
    }
    expect(parseTimeRangePreference("all", 30)).toBeNull();
  });

  it("falls back to the domain default for missing or invalid persisted values", () => {
    expect(parseTimeRangePreference(null, 90)).toBe(90);
    expect(parseTimeRangePreference("", 90)).toBe(90);
    expect(parseTimeRangePreference("0", 90)).toBe(90);
    expect(parseTimeRangePreference("-30", 90)).toBe(90);
    expect(parseTimeRangePreference("31", 90)).toBe(90);
    expect(parseTimeRangePreference("9999", 90)).toBe(90);
    expect(parseTimeRangePreference("not-a-range", 90)).toBe(90);
  });

  it("falls back to the domain default for corrupt non-string storage values", () => {
    const corruptValues: unknown[] = [90, true, {}, ["90"]];

    for (const persistedValue of corruptValues) {
      expect(parseTimeRangePreference(persistedValue, 30)).toBe(30);
    }
  });
});

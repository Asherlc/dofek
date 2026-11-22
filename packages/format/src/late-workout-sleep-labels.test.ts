import { describe, expect, it } from "vitest";
import { sameDateNightLabel, timingLabel } from "./late-workout-sleep-labels.ts";

const name = (id: string) => id.toUpperCase();
const night = (actualOnset: string | null, sleepProvider = "polar") => ({
  actualOnset,
  sleepProvider,
});

describe("timingLabel", () => {
  it("handles missing, zero, early, and late offsets", () => {
    expect(timingLabel(null)).toBeNull();
    expect(timingLabel(0.4)).toBe("At usual onset");
    expect(timingLabel(-90)).toBe("1h 30m before usual onset");
    expect(timingLabel(45)).toBe("45m after usual onset");
  });
});

describe("sameDateNightLabel", () => {
  const firstNight = night("2026-03-10T00:10:00Z");
  const laterNight = night("2026-03-10T01:10:00Z");

  it("returns null for a single record", () => {
    expect(sameDateNightLabel(firstNight, undefined, "UTC", name)).toBeNull();
    expect(sameDateNightLabel(firstNight, [firstNight], "UTC", name)).toBeNull();
  });

  it("uses the onset time when it is unique", () => {
    expect(sameDateNightLabel(firstNight, [firstNight, laterNight], "UTC", name)).toBe(
      "Onset 12:10 AM",
    );
  });

  it("adds provider and record numbers when onsets repeat", () => {
    const repeatedNight = night("2026-03-10T00:10:00Z");
    expect(sameDateNightLabel(repeatedNight, [firstNight, repeatedNight], "UTC", name)).toBe(
      "Onset 12:10 AM · POLAR · Record 2",
    );
  });

  it("falls back to the provider alone without an onset", () => {
    const missing = night(null, "oura");
    expect(sameDateNightLabel(missing, [firstNight, missing], "UTC", name)).toBe("OURA");
  });
});

import { describe, expect, it } from "vitest";
import { climbingLogEntryFixture } from "../repositories/climbing-test-helpers.ts";
import { climbingChartAnnotations } from "./climbing-chart-annotations.ts";

describe("climbing chart annotations", () => {
  it.each([null, [], {}, { date: "not a time" }, { date: "2026-10-01" }])(
    "leaves incomplete source timing unplotted: %j",
    (raw) => {
      expect(
        climbingChartAnnotations(
          climbingLogEntryFixture({ providerId: "kaya", externalId: "kaya:ascent:123", raw }),
        ),
      ).toEqual([]);
    },
  );
  it("labels unnamed ascents with their recorded color without inventing a grade", () => {
    const entry = climbingLogEntryFixture({
      providerId: "kaya",
      externalId: "kaya:ascent:123",
      raw: { date: "2026-10-01T17:15:00+02:00", climb: { color: { name: "blue" } } },
    });
    expect(climbingChartAnnotations(entry)).toEqual([
      { id: entry.id, label: "Blue climb", startedAt: "2026-10-01T15:15:00.000Z", endedAt: null },
    ]);
  });
});

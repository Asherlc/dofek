import { describe, expect, it } from "vitest";
import { climbingLogEntryFixture } from "../repositories/climbing-test-helpers.ts";
import { climbingChartAnnotations } from "./climbing-chart-annotations.ts";

describe("climbing chart annotations", () => {
  it("plots the actual timestamp format retained by KAYA CSV exports", () => {
    const entry = climbingLogEntryFixture({
      providerId: "kaya-export",
      externalId: "kaya:entry:123",
      title: "Pink climb",
      raw: { date: " Mon Jul 06 2026 22:21:59 GMT+0000 (GMT+00:00) " },
    });
    expect(climbingChartAnnotations(entry)).toEqual([
      { id: entry.id, label: "Pink climb", startedAt: "2026-07-06T22:21:59.000Z", endedAt: null },
    ]);
  });
  it.each(["Mon Jul 06 2026 22:21:59", "Mon Jul 06 2026 22:21:59 GMT+9999", "invalid GMT+0000"])(
    "rejects an ambiguous or invalid CSV timestamp: %s",
    (date) => {
      expect(
        climbingChartAnnotations(
          climbingLogEntryFixture({
            providerId: "kaya-export",
            externalId: "kaya:entry:123",
            raw: { date },
          }),
        ),
      ).toEqual([]);
    },
  );
  it.each([null, [], {}, { date: "not a time" }, { date: "2026-10-01" }])(
    "leaves incomplete source timing without chart markers: %j",
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

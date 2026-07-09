import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseKayaExport } from "./import.ts";

const fixturePath = join(import.meta.dirname, "fixtures/representative-export.csv");
const fixtureText = readFileSync(fixturePath, "utf8");
const kayaHeader =
  "date,stiffness,rating,ascent_type,attempts,grade,color,climb_name,gym,location,country";

describe("parseKayaExport", () => {
  it("uses the observed Kaya CSV header exactly", () => {
    expect(fixtureText.split(/\r?\n/)[0]).toBe(kayaHeader);
  });

  it("groups rows into climbing activities by gym and UTC calendar day", () => {
    const result = parseKayaExport(fixtureText);

    expect(result.errors).toEqual([]);
    expect(result.activities).toHaveLength(3);
    expect(
      result.activities.map((activity) => ({
        externalId: activity.externalId,
        name: activity.name,
        locationName: activity.locationName,
        activityType: activity.activityType,
        startedAt: activity.startedAt.toISOString(),
        endedAt: activity.endedAt.toISOString(),
        entryCount: activity.entries.length,
      })),
    ).toEqual([
      {
        externalId: expect.stringMatching(/^kaya:session:/),
        name: "Kaya climbing at Touchstone Great Western Power Company",
        locationName: "Touchstone Great Western Power Company",
        activityType: "rock_climbing",
        startedAt: "2026-07-06T22:21:59.000Z",
        endedAt: "2026-07-06T22:23:07.000Z",
        entryCount: 2,
      },
      {
        externalId: expect.stringMatching(/^kaya:session:/),
        name: "Kaya climbing at Touchstone Great Western Power Company",
        locationName: "Touchstone Great Western Power Company",
        activityType: "rock_climbing",
        startedAt: "2026-07-08T15:09:12.000Z",
        endedAt: "2026-07-08T15:09:12.000Z",
        entryCount: 1,
      },
      {
        externalId: expect.stringMatching(/^kaya:session:/),
        name: "Kaya climbing at Touchstone Pacific Pipe",
        locationName: "Touchstone Pacific Pipe",
        activityType: "rock_climbing",
        startedAt: "2026-07-09T14:22:19.000Z",
        endedAt: "2026-07-09T15:17:17.000Z",
        entryCount: 3,
      },
    ]);
  });

  it("maps fixture rows to canonical climbing entries without expanding attempts", () => {
    const result = parseKayaExport(fixtureText);
    const pacificPipeSession = result.activities.find(
      (activity) => activity.locationName === "Touchstone Pacific Pipe",
    );

    expect(pacificPipeSession?.entries).toEqual([
      expect.objectContaining({
        externalId: expect.stringMatching(/^kaya:entry:/),
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V0",
        sent: true,
        routeName: null,
        locationName: "Touchstone Pacific Pipe",
        sourceName: "Kaya",
      }),
      expect.objectContaining({
        externalId: expect.stringMatching(/^kaya:entry:/),
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V3",
        sent: true,
        routeName: null,
        raw: expect.objectContaining({
          attempts: 2,
          ascentType: "Redpoint",
          color: "Pink",
          date: "Thu Jul 09 2026 14:55:40 GMT+0000 (GMT+00:00)",
          gym: "Touchstone Pacific Pipe",
          location: null,
          country: null,
          rating: null,
          stiffness: 0,
        }),
      }),
      expect.objectContaining({
        externalId: expect.stringMatching(/^kaya:entry:/),
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V3",
        sent: true,
        routeName: null,
        raw: expect.objectContaining({
          attempts: 1,
          ascentType: "Onsight",
        }),
      }),
    ]);
  });

  it("uses climb_name as route name when present and null when empty", () => {
    const result = parseKayaExport(fixtureText);
    const greatWesternSession = result.activities[0];

    expect(greatWesternSession?.entries[0]?.routeName).toBeNull();
    expect(greatWesternSession?.entries[1]?.routeName).toBe("TCS #7");
  });

  it("generates deterministic external ids from stable row and session data", () => {
    const first = parseKayaExport(fixtureText);
    const second = parseKayaExport(fixtureText);

    expect(first.activities.map((activity) => activity.externalId)).toEqual(
      second.activities.map((activity) => activity.externalId),
    );
    expect(
      first.activities.flatMap((activity) => activity.entries.map((entry) => entry.externalId)),
    ).toEqual(
      second.activities.flatMap((activity) => activity.entries.map((entry) => entry.externalId)),
    );
  });

  it("reports invalid rows with specific messages", () => {
    const cases = [
      {
        csv: `${kayaHeader}\n,0,,Redpoint,,v3,Pink,,Touchstone Pacific Pipe,,`,
        message: "row 2: date is required",
      },
      {
        csv: `${kayaHeader}\nnot-a-date,0,,Redpoint,,v3,Pink,,Touchstone Pacific Pipe,,`,
        message: "row 2: date is not a valid Kaya date",
      },
      {
        csv: `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,v3,Pink,,,,`,
        message: "row 2: gym is required",
      },
      {
        csv: `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,VBoulder,Pink,,Touchstone Pacific Pipe,,`,
        message: "row 2: grade is unsupported",
      },
      {
        csv: `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Project,,v3,Pink,,Touchstone Pacific Pipe,,`,
        message: "row 2: ascent_type is unsupported",
      },
      {
        csv: `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,v3,Pink,,Touchstone Pacific Pipe`,
        message: "row 2: malformed CSV row",
      },
      {
        csv: "wrong,header\nvalue",
        message: "header does not match Kaya export format",
      },
    ];

    for (const testCase of cases) {
      expect(parseKayaExport(testCase.csv).errors).toContainEqual(
        expect.objectContaining({ message: testCase.message }),
      );
    }
  });
});

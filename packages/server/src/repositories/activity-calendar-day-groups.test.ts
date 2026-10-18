import { describe, expect, it } from "vitest";
import { mergeDayGroups } from "./activity-calendar-day-groups.ts";
import { makeCalendarEntry } from "./activity-calendar-test-helpers.ts";

describe("mergeDayGroups", () => {
  it("sorts day groups in descending date order", () => {
    const activeDays = [
      {
        date: "2026-03-17",
        activities: [
          makeCalendarEntry({ id: "active-old", startedAt: "2026-03-17T07:00:00.000Z" }),
        ],
      },
    ];
    const hiddenDays = [
      {
        date: "2026-03-18",
        activities: [
          makeCalendarEntry({ id: "hidden-new", startedAt: "2026-03-18T07:00:00.000Z" }),
        ],
      },
    ];

    expect(mergeDayGroups(activeDays, hiddenDays).map((day) => day.date)).toEqual([
      "2026-03-18",
      "2026-03-17",
    ]);
  });

  it("sorts activities within a day by startedAt descending", () => {
    const activeDays = [
      {
        date: "2026-03-18",
        activities: [
          makeCalendarEntry({
            id: "early",
            startedAt: "2026-03-18T07:00:00.000Z",
          }),
          makeCalendarEntry({
            id: "late",
            startedAt: "2026-03-18T10:00:00.000Z",
          }),
        ],
      },
    ];

    expect(
      mergeDayGroups(activeDays, []).flatMap((day) =>
        day.activities.map((activity) => activity.id),
      ),
    ).toEqual(["late", "early"]);
  });

  it("keeps equal startedAt entries in insertion order", () => {
    const activeDays = [
      {
        date: "2026-03-18",
        activities: [
          makeCalendarEntry({
            id: "first",
            startedAt: "2026-03-18T07:00:00.000Z",
          }),
          makeCalendarEntry({
            id: "second",
            startedAt: "2026-03-18T07:00:00.000Z",
          }),
        ],
      },
    ];

    expect(
      mergeDayGroups(activeDays, []).flatMap((day) =>
        day.activities.map((activity) => activity.id),
      ),
    ).toEqual(["first", "second"]);
  });

  it("prefers active entries when active and hidden activities share the same id", () => {
    const activeDays = [
      {
        date: "2026-03-18",
        activities: [
          makeCalendarEntry({
            id: "shared-id",
            name: "Active Ride",
            startedAt: "2026-03-18T07:00:00.000Z",
          }),
        ],
      },
    ];
    const hiddenDays = [
      {
        date: "2026-03-18",
        activities: [
          makeCalendarEntry({
            id: "shared-id",
            name: "Hidden Ride",
            startedAt: "2026-03-18T07:00:00.000Z",
            isProviderAbsent: true,
          }),
        ],
      },
    ];

    expect(mergeDayGroups(activeDays, hiddenDays)).toEqual([
      {
        date: "2026-03-18",
        activities: [expect.objectContaining({ id: "shared-id", name: "Active Ride" })],
      },
    ]);
  });
});

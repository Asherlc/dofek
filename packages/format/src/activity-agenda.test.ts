import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_AGENDA_RANGES,
  activityAgendaPlannedWindow,
  activityAgendaRange,
  filterUpcomingActivityAgenda,
  formatActivityAgendaCaption,
  isActivityAgendaPreset,
  mergeActivityAgendaDays,
  resolveActivityAgendaOwnedPlannedWindow,
  upcomingActivityAgendaRange,
  withActivityAgendaEmptyDays,
} from "./activity-agenda.ts";
import { shiftDateYmd } from "./format.ts";

describe("upcomingActivityAgendaRange", () => {
  it.each([
    ["2026-11-24", "2027-02-21"],
    ["2026-12-31", "2027-03-30"],
    ["2028-02-01", "2028-04-30"],
    ["2026-03-08", "2026-06-05"],
    ["2026-11-01", "2027-01-29"],
  ])("includes today and exactly 89 later dates from %s", (today, endDate) => {
    expect(upcomingActivityAgendaRange(today)).toEqual({ startDate: today, endDate });
  });
});

describe("filterUpcomingActivityAgenda", () => {
  it("moves endpoint null-first rows after timed plans without changing input or timed order", () => {
    const noTime = { id: "no time", sportType: "Ride", startTime: null };
    const anotherNoTime = { id: "another no time", sportType: "Run", startTime: null };
    const early = { id: "early", sportType: "VirtualRide", startTime: "06:00" };
    const late = { id: "late", sportType: "cycling", startTime: "18:00" };
    const next = { id: "next", sportType: "Ride", startTime: null };
    const input = [
      { date: "2026-11-24", workouts: [noTime, anotherNoTime, early, late] },
      { date: "2026-11-25", workouts: [next] },
    ];
    expect(filterUpcomingActivityAgenda(input)).toEqual({
      days: [
        { date: "2026-11-24", workouts: [early, late, noTime, anotherNoTime] },
        { date: "2026-11-25", workouts: [next] },
      ],
      sports: ["cycling", "running"],
    });
    expect(filterUpcomingActivityAgenda(input, "cycling")).toEqual({
      days: [
        { date: "2026-11-24", workouts: [early, late, noTime] },
        { date: "2026-11-25", workouts: [next] },
      ],
      sports: ["cycling", "running"],
    });
    expect(input).toEqual([
      { date: "2026-11-24", workouts: [noTime, anotherNoTime, early, late] },
      { date: "2026-11-25", workouts: [next] },
    ]);
  });

  it("normalizes aliases and trimmed legacy keys while leaving unknown sports under All", () => {
    const workouts = [
      "Ride",
      "VirtualRide",
      "cycling",
      " ROAD_CYCLING ",
      "Run",
      " running ",
      "mystery",
      "constructor",
      "",
      "  ",
      null,
    ].map((sportType, id) => ({ id, sportType, startTime: null }));
    const input = [{ date: "2026-11-24", workouts }];
    expect(filterUpcomingActivityAgenda(input)).toEqual({
      days: input,
      sports: ["cycling", "running"],
    });
    expect(filterUpcomingActivityAgenda(input, "cycling")).toEqual({
      days: [{ date: "2026-11-24", workouts: workouts.slice(0, 4) }],
      sports: ["cycling", "running"],
    });
    expect(filterUpcomingActivityAgenda(input, "running")).toEqual({
      days: [{ date: "2026-11-24", workouts: workouts.slice(4, 6) }],
      sports: ["cycling", "running"],
    });
    expect(filterUpcomingActivityAgenda(input, "other").days).toEqual([]);
  });
  const first = { id: "first", sportType: "running", startTime: null };
  const second = { id: "second", sportType: "cycling", startTime: null };
  const third = { id: "third", sportType: "running", startTime: null };
  const missing = { id: "missing", sportType: null, startTime: null };
  const empty = { id: "empty", sportType: "", startTime: null };
  const blank = { id: "blank", sportType: "  ", startTime: null };
  const last = { id: "last", sportType: "swimming", startTime: null };
  const days = [
    { date: "2026-11-24", workouts: [first, second, third, missing, empty, blank] },
    { date: "2026-11-25", workouts: [] },
    { date: "2026-11-26", workouts: [last] },
  ];

  it("returns empty results for default, explicit missing, and empty feeds", () => {
    expect(filterUpcomingActivityAgenda()).toEqual({ days: [], sports: [] });
    expect(filterUpcomingActivityAgenda(undefined)).toEqual({ days: [], sports: [] });
    expect(filterUpcomingActivityAgenda([])).toEqual({ days: [], sports: [] });
    expect(filterUpcomingActivityAgenda([{ date: "2026-11-24", workouts: [] }])).toEqual({
      days: [],
      sports: [],
    });
  });

  it("removes empty days and preserves day and workout order including unknown sports", () => {
    expect(filterUpcomingActivityAgenda(days)).toEqual({
      days: [
        { date: "2026-11-24", workouts: [first, second, third, missing, empty, blank] },
        { date: "2026-11-26", workouts: [last] },
      ],
      sports: ["running", "cycling", "swimming"],
    });
  });

  it("filters exact raw sports and drops unmatched days while retaining all distinct choices", () => {
    expect(filterUpcomingActivityAgenda(days, "running")).toEqual({
      days: [{ date: "2026-11-24", workouts: [first, third] }],
      sports: ["running", "cycling", "swimming"],
    });
    expect(filterUpcomingActivityAgenda(days, "swimming")).toEqual({
      days: [{ date: "2026-11-26", workouts: [last] }],
      sports: ["running", "cycling", "swimming"],
    });
  });

  it("keeps a selected sport available when it is absent from the feed", () => {
    expect(filterUpcomingActivityAgenda(days, "hiking")).toEqual({
      days: [],
      sports: ["running", "cycling", "swimming", "hiking"],
    });
    expect(filterUpcomingActivityAgenda(undefined, "hiking")).toEqual({
      days: [],
      sports: ["hiking"],
    });
  });
});

describe("ACTIVITY_AGENDA_RANGES", () => {
  it("lists the Activities presets in display order", () => {
    expect(ACTIVITY_AGENDA_RANGES.map((range) => range.preset)).toEqual([
      "this-week",
      "4-weeks",
      "8-weeks",
      "12-weeks",
    ]);
  });

  it("narrows known preset strings", () => {
    expect(isActivityAgendaPreset("this-week")).toBe(true);
    expect(isActivityAgendaPreset("next-week")).toBe(false);
  });
});

describe("activityAgendaRange", () => {
  it("uses Monday–Sunday for this week on a mid-week day", () => {
    // Tuesday 2026-11-24 (matches the approved canvas fixtures).
    expect(activityAgendaRange("this-week", "2026-11-24")).toEqual({
      startDate: "2026-11-23",
      endDate: "2026-11-29",
      weeks: 1,
    });
  });

  it("keeps this week on Monday and Sunday anchors", () => {
    expect(activityAgendaRange("this-week", "2026-11-23")).toEqual({
      startDate: "2026-11-23",
      endDate: "2026-11-29",
      weeks: 1,
    });
    expect(activityAgendaRange("this-week", "2026-11-29")).toEqual({
      startDate: "2026-11-23",
      endDate: "2026-11-29",
      weeks: 1,
    });
  });

  it("matches inclusive activityOverview ranges ending today", () => {
    expect(activityAgendaRange("4-weeks", "2026-11-24")).toEqual({
      startDate: "2026-10-28",
      endDate: "2026-11-24",
      weeks: 4,
    });
    expect(activityAgendaRange("8-weeks", "2026-11-24")).toEqual({
      startDate: "2026-09-30",
      endDate: "2026-11-24",
      weeks: 8,
    });
    expect(activityAgendaRange("12-weeks", "2026-11-24")).toEqual({
      startDate: "2026-09-02",
      endDate: "2026-11-24",
      weeks: 12,
    });
  });

  it("crosses month and year boundaries with calendar-day helpers", () => {
    expect(activityAgendaRange("4-weeks", "2026-01-05")).toEqual({
      startDate: shiftDateYmd("2026-01-05", -(4 * 7 - 1)),
      endDate: "2026-01-05",
      weeks: 4,
    });
  });

  it("stays stable across US spring-forward and fall-back dates", () => {
    // 2026-03-08 springs forward; 2026-11-01 falls back.
    expect(activityAgendaRange("this-week", "2026-03-08")).toEqual({
      startDate: "2026-03-02",
      endDate: "2026-03-08",
      weeks: 1,
    });
    expect(activityAgendaRange("this-week", "2026-11-01")).toEqual({
      startDate: "2026-10-26",
      endDate: "2026-11-01",
      weeks: 1,
    });
    expect(activityAgendaRange("4-weeks", "2026-03-08").startDate).toBe(
      shiftDateYmd("2026-03-08", -(4 * 7 - 1)),
    );
    expect(activityAgendaRange("4-weeks", "2026-11-01").startDate).toBe(
      shiftDateYmd("2026-11-01", -(4 * 7 - 1)),
    );
  });
});

describe("resolveActivityAgendaOwnedPlannedWindow", () => {
  const selectedSpan = { startDate: "2026-11-23", endDate: "2026-11-29" };

  it("uses the showing page plannedWindow even for same-range placeholder paging", () => {
    expect(
      resolveActivityAgendaOwnedPlannedWindow({
        futureOnly: false,
        selectedSpan,
        pageData: {
          plannedWindow: { startDate: "2026-11-20", endDate: "2026-11-24" },
        },
        activityPage: 1,
      }),
    ).toEqual({ startDate: "2026-11-20", endDate: "2026-11-24" });
  });

  it("falls back to the selected span only on page zero without a plannedWindow key", () => {
    expect(
      resolveActivityAgendaOwnedPlannedWindow({
        futureOnly: false,
        selectedSpan,
        pageData: {},
        activityPage: 0,
      }),
    ).toEqual(selectedSpan);
    expect(
      resolveActivityAgendaOwnedPlannedWindow({
        futureOnly: false,
        selectedSpan,
        pageData: undefined,
        activityPage: 1,
      }),
    ).toBeNull();
  });

  it("uses the selected span for future-only regardless of page data", () => {
    expect(
      resolveActivityAgendaOwnedPlannedWindow({
        futureOnly: true,
        selectedSpan,
        pageData: { plannedWindow: { startDate: "2026-01-01", endDate: "2026-01-02" } },
        activityPage: 3,
      }),
    ).toEqual(selectedSpan);
  });
});

describe("activityAgendaPlannedWindow", () => {
  const range = { rangeStart: "2026-03-01", rangeEnd: "2026-03-31" };

  it("gives an empty recorded page the whole requested range", () => {
    expect(
      activityAgendaPlannedWindow({
        ...range,
        pageActivityDates: [],
        hasLaterPage: false,
      }),
    ).toEqual({ startDate: "2026-03-01", endDate: "2026-03-31" });
  });

  it("claims from the page's oldest day through the range end on page zero", () => {
    expect(
      activityAgendaPlannedWindow({
        ...range,
        pageActivityDates: ["2026-03-31", "2026-03-28"],
        hasLaterPage: true,
      }),
    ).toEqual({ startDate: "2026-03-28", endDate: "2026-03-31" });
  });

  it("uses the day before the previous page's last activity as the upper bound", () => {
    expect(
      activityAgendaPlannedWindow({
        ...range,
        pageActivityDates: ["2026-03-27", "2026-03-20"],
        hasLaterPage: true,
        previousPageLastActivityDate: "2026-03-28",
      }),
    ).toEqual({ startDate: "2026-03-20", endDate: "2026-03-27" });
  });

  it("extends to the range start on the last page", () => {
    expect(
      activityAgendaPlannedWindow({
        ...range,
        pageActivityDates: ["2026-03-15"],
        hasLaterPage: false,
        previousPageLastActivityDate: "2026-03-20",
      }),
    ).toEqual({ startDate: "2026-03-01", endDate: "2026-03-19" });
  });

  it("returns null when the eligible interval is inverted", () => {
    expect(
      activityAgendaPlannedWindow({
        ...range,
        pageActivityDates: ["2026-03-30"],
        hasLaterPage: true,
        previousPageLastActivityDate: "2026-03-20",
      }),
    ).toBeNull();
  });

  it("claims oldest-first pages from range start through the page's last date", () => {
    expect(
      activityAgendaPlannedWindow({
        ...range,
        dateOrder: "oldest",
        pageActivityDates: ["2026-03-01", "2026-03-05"],
        hasLaterPage: true,
      }),
    ).toEqual({ startDate: "2026-03-01", endDate: "2026-03-05" });
  });

  it("uses the day after the previous page's last activity as the oldest-first lower bound", () => {
    expect(
      activityAgendaPlannedWindow({
        ...range,
        dateOrder: "oldest",
        pageActivityDates: ["2026-03-06", "2026-03-12"],
        hasLaterPage: true,
        previousPageLastActivityDate: "2026-03-05",
      }),
    ).toEqual({ startDate: "2026-03-06", endDate: "2026-03-12" });
  });

  it("extends oldest-first pages to the range end on the last page", () => {
    expect(
      activityAgendaPlannedWindow({
        ...range,
        dateOrder: "oldest",
        pageActivityDates: ["2026-03-20"],
        hasLaterPage: false,
        previousPageLastActivityDate: "2026-03-12",
      }),
    ).toEqual({ startDate: "2026-03-13", endDate: "2026-03-31" });
  });

  it("keeps a split date's plans on the first oldest-first page", () => {
    expect(
      activityAgendaPlannedWindow({
        ...range,
        dateOrder: "oldest",
        pageActivityDates: ["2026-03-05", "2026-03-05"],
        hasLaterPage: true,
      }),
    ).toEqual({ startDate: "2026-03-01", endDate: "2026-03-05" });
    expect(
      activityAgendaPlannedWindow({
        ...range,
        dateOrder: "oldest",
        pageActivityDates: ["2026-03-05", "2026-03-08"],
        hasLaterPage: true,
        previousPageLastActivityDate: "2026-03-05",
      }),
    ).toEqual({ startDate: "2026-03-06", endDate: "2026-03-08" });
  });

  it("returns null when an oldest-first interval is inverted", () => {
    expect(
      activityAgendaPlannedWindow({
        ...range,
        dateOrder: "oldest",
        pageActivityDates: ["2026-03-10"],
        hasLaterPage: true,
        previousPageLastActivityDate: "2026-03-20",
      }),
    ).toBeNull();
  });
});

describe("mergeActivityAgendaDays", () => {
  it("merges activities and workouts onto shared dates in descending order by default", () => {
    expect(
      mergeActivityAgendaDays(
        [
          { date: "2026-03-10", activities: [{ id: "a1" }] },
          { date: "2026-03-08", activities: [{ id: "a2" }] },
        ],
        [
          { date: "2026-03-10", workouts: [{ id: "w1" }] },
          { date: "2026-03-09", workouts: [{ id: "w2" }] },
        ],
        { startDate: "2026-03-08", endDate: "2026-03-10" },
      ),
    ).toEqual([
      { date: "2026-03-10", activities: [{ id: "a1" }], workouts: [{ id: "w1" }] },
      { date: "2026-03-09", activities: [], workouts: [{ id: "w2" }] },
      { date: "2026-03-08", activities: [{ id: "a2" }], workouts: [] },
    ]);
  });

  it("merges dates in ascending calendar order when dateOrder is oldest", () => {
    expect(
      mergeActivityAgendaDays(
        [
          { date: "2026-03-10", activities: [{ id: "a1" }] },
          { date: "2026-03-08", activities: [{ id: "a2" }] },
        ],
        [
          { date: "2026-03-10", workouts: [{ id: "w1" }] },
          { date: "2026-03-09", workouts: [{ id: "w2" }] },
        ],
        { startDate: "2026-03-08", endDate: "2026-03-10" },
        "oldest",
      ),
    ).toEqual([
      { date: "2026-03-08", activities: [{ id: "a2" }], workouts: [] },
      { date: "2026-03-09", activities: [], workouts: [{ id: "w2" }] },
      { date: "2026-03-10", activities: [{ id: "a1" }], workouts: [{ id: "w1" }] },
    ]);
  });

  it("keeps one feed when the other is absent and ignores plans outside the window", () => {
    expect(
      mergeActivityAgendaDays([{ date: "2026-03-10", activities: [{ id: "a1" }] }], undefined, {
        startDate: "2026-03-10",
        endDate: "2026-03-10",
      }),
    ).toEqual([{ date: "2026-03-10", activities: [{ id: "a1" }], workouts: [] }]);

    expect(
      mergeActivityAgendaDays(
        undefined,
        [
          { date: "2026-03-11", workouts: [{ id: "outside" }] },
          { date: "2026-03-10", workouts: [{ id: "inside" }] },
        ],
        { startDate: "2026-03-10", endDate: "2026-03-10" },
      ),
    ).toEqual([{ date: "2026-03-10", activities: [], workouts: [{ id: "inside" }] }]);
  });

  it("returns no days when both feeds are absent or the planned window is null", () => {
    expect(mergeActivityAgendaDays(undefined, undefined, null)).toEqual([]);
    expect(
      mergeActivityAgendaDays(
        [{ date: "2026-03-10", activities: [{ id: "a1" }] }],
        [{ date: "2026-03-10", workouts: [{ id: "w1" }] }],
        null,
      ),
    ).toEqual([{ date: "2026-03-10", activities: [{ id: "a1" }], workouts: [] }]);
  });
});

describe("withActivityAgendaEmptyDays", () => {
  it("fills missing weekdays inside the planned window in calendar order", () => {
    expect(
      withActivityAgendaEmptyDays(
        [
          { date: "2026-11-24", activities: [{ id: "a1" }], workouts: [{ id: "w1" }] },
          { date: "2026-11-26", activities: [], workouts: [{ id: "w2" }] },
        ],
        { startDate: "2026-11-23", endDate: "2026-11-29" },
        "oldest",
      ),
    ).toEqual([
      { date: "2026-11-23", activities: [], workouts: [] },
      { date: "2026-11-24", activities: [{ id: "a1" }], workouts: [{ id: "w1" }] },
      { date: "2026-11-25", activities: [], workouts: [] },
      { date: "2026-11-26", activities: [], workouts: [{ id: "w2" }] },
      { date: "2026-11-27", activities: [], workouts: [] },
      { date: "2026-11-28", activities: [], workouts: [] },
      { date: "2026-11-29", activities: [], workouts: [] },
    ]);
  });

  it("leaves days unchanged when the planned window is null", () => {
    const days = [{ date: "2026-11-24", activities: [{ id: "a1" }], workouts: [] }];
    expect(withActivityAgendaEmptyDays(days, null, "oldest")).toEqual(days);
  });
});

describe("formatActivityAgendaCaption", () => {
  it("formats the selected inclusive span with UTC calendar labels", () => {
    expect(formatActivityAgendaCaption("2026-11-23", "2026-11-29")).toBe("Nov 23 – Nov 29, 2026");
  });

  it("includes both years when the span crosses a year boundary", () => {
    expect(formatActivityAgendaCaption("2026-11-25", "2027-02-22")).toBe(
      "Nov 25, 2026 – Feb 22, 2027",
    );
  });

  it("still formats when Intl.DateTimeFormat.prototype.formatRange is unavailable", () => {
    const formatRange = vi
      .spyOn(Intl.DateTimeFormat.prototype, "formatRange")
      .mockImplementation(() => {
        throw new Error("formatRange unavailable on Hermes");
      });
    try {
      expect(formatActivityAgendaCaption("2026-11-23", "2026-11-29")).toBe("Nov 23 – Nov 29, 2026");
      expect(formatRange).not.toHaveBeenCalled();
    } finally {
      formatRange.mockRestore();
    }
  });
});

import { describe, expect, it } from "vitest";
import { SyncWindow } from "../sync-window.ts";
import {
  advanceZivaSyncCheckpoint,
  planZivaSyncChunk,
  type ZivaSyncCheckpoint,
} from "./sync-plan.ts";

describe("planZivaSyncChunk", () => {
  it("keeps a same-day calendar window literal in a western home timezone", () => {
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const window = SyncWindow.fromDateRange({
        sinceDate: "2026-09-20",
        untilDate: "2026-09-20",
      });

      expect(planZivaSyncChunk(window, null)).toEqual({
        checkpoint: {
          version: 1,
          nextDate: "2026-09-20",
          endDate: "2026-09-20",
          recordsSynced: 0,
        },
        dates: ["2026-09-20"],
      });
    } finally {
      if (previousTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimezone;
      }
    }
  });

  it("includes both explicit backfill bounds", () => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "2026-04-08",
      untilDate: "2026-04-10",
    });

    expect(planZivaSyncChunk(window, null).dates).toEqual([
      "2026-04-08",
      "2026-04-09",
      "2026-04-10",
    ]);
  });

  it("includes leap day in date-only arithmetic", () => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "2024-02-28",
      untilDate: "2024-03-01",
    });

    expect(planZivaSyncChunk(window, null).dates).toEqual([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
  });

  it("does not skip a date across daylight-saving time", () => {
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const window = SyncWindow.fromDateRange({
        sinceDate: "2026-03-07",
        untilDate: "2026-03-10",
      });

      expect(planZivaSyncChunk(window, null).dates).toEqual([
        "2026-03-07",
        "2026-03-08",
        "2026-03-09",
        "2026-03-10",
      ]);
    } finally {
      if (previousTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimezone;
      }
    }
  });

  it("clamps a full window to 730 inclusive dates", () => {
    const window = SyncWindow.full(new Date("2026-09-20T18:45:00.000Z"));

    const chunk = planZivaSyncChunk(window, null);

    expect(chunk.checkpoint).toEqual({
      version: 1,
      nextDate: "2024-09-21",
      endDate: "2026-09-20",
      recordsSynced: 0,
    });
    expect(chunk.dates).toEqual([
      "2024-09-21",
      "2024-09-22",
      "2024-09-23",
      "2024-09-24",
      "2024-09-25",
      "2024-09-26",
      "2024-09-27",
      "2024-09-28",
      "2024-09-29",
      "2024-09-30",
      "2024-10-01",
      "2024-10-02",
      "2024-10-03",
      "2024-10-04",
    ]);
  });

  it("plans all 14 dates when the inclusive range is exactly one chunk", () => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "2026-01-01",
      untilDate: "2026-01-14",
    });

    expect(planZivaSyncChunk(window, null).dates).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
      "2026-01-11",
      "2026-01-12",
      "2026-01-13",
      "2026-01-14",
    ]);
  });

  it("leaves the fifteenth date for a continuation chunk", () => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "2026-01-01",
      untilDate: "2026-01-15",
    });
    const firstChunk = planZivaSyncChunk(window, null);
    let checkpoint: ZivaSyncCheckpoint | null = firstChunk.checkpoint;

    for (const completedDate of firstChunk.dates) {
      if (checkpoint === null) throw new Error("Checkpoint completed before the end of the chunk");
      checkpoint = advanceZivaSyncCheckpoint(checkpoint, completedDate, 0);
    }

    expect(checkpoint).toEqual({
      version: 1,
      nextDate: "2026-01-15",
      endDate: "2026-01-15",
      recordsSynced: 0,
    });
    expect(planZivaSyncChunk(window, checkpoint).dates).toEqual(["2026-01-15"]);
  });

  it("iterates a full history window in bounded contiguous chunks", () => {
    const window = SyncWindow.full(new Date("2026-09-20T18:45:00.000Z"));
    const plannedDates: string[] = [];
    const chunkLengths: number[] = [];
    let rawCheckpoint: unknown = null;

    while (true) {
      const chunk = planZivaSyncChunk(window, rawCheckpoint);
      plannedDates.push(...chunk.dates);
      chunkLengths.push(chunk.dates.length);
      let checkpoint: ZivaSyncCheckpoint | null = chunk.checkpoint;

      for (const completedDate of chunk.dates) {
        if (checkpoint === null) {
          throw new Error("Checkpoint completed before the end of the planned dates");
        }
        checkpoint = advanceZivaSyncCheckpoint(
          checkpoint,
          completedDate,
          plannedDates.indexOf(completedDate) + 1,
        );
      }

      if (checkpoint === null) break;
      rawCheckpoint = checkpoint;
    }

    expect(plannedDates).toHaveLength(730);
    expect(plannedDates[0]).toBe("2024-09-21");
    expect(plannedDates.at(-1)).toBe("2026-09-20");
    expect(new Set(plannedDates)).toHaveLength(730);
    expect(chunkLengths).toEqual([...Array.from({ length: 52 }, () => 14), 2]);
    for (let dateIndex = 1; dateIndex < plannedDates.length; dateIndex += 1) {
      const previousDate = new Date(`${plannedDates[dateIndex - 1]}T00:00:00.000Z`);
      const currentDate = new Date(`${plannedDates[dateIndex]}T00:00:00.000Z`);
      expect(currentDate.getTime() - previousDate.getTime()).toBe(86_400_000);
    }
  });

  it("resumes at the saved next date with the saved cumulative count", () => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "2026-04-01",
      untilDate: "2026-04-05",
    });
    const checkpoint = Object.freeze({
      version: 1 as const,
      nextDate: "2026-04-03",
      endDate: "2026-04-05",
      recordsSynced: 7,
    });

    const chunk = planZivaSyncChunk(window, checkpoint);

    expect(chunk).toEqual({
      checkpoint: {
        version: 1,
        nextDate: "2026-04-03",
        endDate: "2026-04-05",
        recordsSynced: 7,
      },
      dates: ["2026-04-03", "2026-04-04", "2026-04-05"],
    });
    expect(checkpoint).toEqual({
      version: 1,
      nextDate: "2026-04-03",
      endDate: "2026-04-05",
      recordsSynced: 7,
    });
  });

  it("does not advance a checkpoint merely by planning its chunk", () => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "2026-04-01",
      untilDate: "2026-04-03",
    });
    const checkpoint = Object.freeze({
      version: 1 as const,
      nextDate: "2026-04-02",
      endDate: "2026-04-03",
      recordsSynced: 5,
    });

    const firstPlan = planZivaSyncChunk(window, checkpoint);
    const retryPlan = planZivaSyncChunk(window, checkpoint);

    expect(firstPlan).toEqual(retryPlan);
    expect(retryPlan.checkpoint.nextDate).toBe("2026-04-02");
    expect(checkpoint.nextDate).toBe("2026-04-02");
  });

  it.each([
    ["undefined", undefined],
    ["an array", []],
    ["a missing field", { version: 1, nextDate: "2026-04-01", endDate: "2026-04-03" }],
    [
      "an unknown field",
      {
        version: 1,
        nextDate: "2026-04-01",
        endDate: "2026-04-03",
        recordsSynced: 0,
        legacyCursor: 2,
      },
    ],
    [
      "a future version",
      { version: 2, nextDate: "2026-04-01", endDate: "2026-04-03", recordsSynced: 0 },
    ],
    [
      "an invalid next date",
      { version: 1, nextDate: "2026-02-30", endDate: "2026-04-03", recordsSynced: 0 },
    ],
    [
      "an invalid end date",
      { version: 1, nextDate: "2026-04-01", endDate: "2026-02-30", recordsSynced: 0 },
    ],
    [
      "a fractional count",
      { version: 1, nextDate: "2026-04-01", endDate: "2026-04-03", recordsSynced: 1.5 },
    ],
    [
      "a negative count",
      { version: 1, nextDate: "2026-04-01", endDate: "2026-04-03", recordsSynced: -1 },
    ],
  ])("rejects %s instead of silently starting over", (_label, rawCheckpoint) => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "2026-04-01",
      untilDate: "2026-04-03",
    });

    expect(() => planZivaSyncChunk(window, rawCheckpoint)).toThrow();
  });

  it("rejects a checkpoint from a changed end date", () => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "2026-04-01",
      untilDate: "2026-04-03",
    });

    expect(() =>
      planZivaSyncChunk(window, {
        version: 1,
        nextDate: "2026-04-02",
        endDate: "2026-04-04",
        recordsSynced: 4,
      }),
    ).toThrow();
  });

  it.each([
    ["before", "2026-03-31"],
    ["after", "2026-04-04"],
  ])("rejects a next date %s the current window", (_position, nextDate) => {
    const window = SyncWindow.fromDateRange({
      sinceDate: "2026-04-01",
      untilDate: "2026-04-03",
    });

    expect(() =>
      planZivaSyncChunk(window, {
        version: 1,
        nextDate,
        endDate: "2026-04-03",
        recordsSynced: 4,
      }),
    ).toThrow();
  });
});

describe("advanceZivaSyncCheckpoint", () => {
  it("returns the next in-range date with the new cumulative count", () => {
    const checkpoint = Object.freeze<ZivaSyncCheckpoint>({
      version: 1,
      nextDate: "2026-04-02",
      endDate: "2026-04-04",
      recordsSynced: 5,
    });

    expect(advanceZivaSyncCheckpoint(checkpoint, "2026-04-02", 8)).toEqual({
      version: 1,
      nextDate: "2026-04-03",
      endDate: "2026-04-04",
      recordsSynced: 8,
    });
    expect(checkpoint).toEqual({
      version: 1,
      nextDate: "2026-04-02",
      endDate: "2026-04-04",
      recordsSynced: 5,
    });
  });

  it("advances an empty day without increasing the cumulative count", () => {
    const checkpoint: ZivaSyncCheckpoint = {
      version: 1,
      nextDate: "2026-04-02",
      endDate: "2026-04-04",
      recordsSynced: 5,
    };

    expect(advanceZivaSyncCheckpoint(checkpoint, "2026-04-02", 5)).toEqual({
      version: 1,
      nextDate: "2026-04-03",
      endDate: "2026-04-04",
      recordsSynced: 5,
    });
  });

  it("returns null after the final date instead of an out-of-range sentinel", () => {
    const checkpoint: ZivaSyncCheckpoint = {
      version: 1,
      nextDate: "2026-04-04",
      endDate: "2026-04-04",
      recordsSynced: 8,
    };

    expect(advanceZivaSyncCheckpoint(checkpoint, "2026-04-04", 9)).toBeNull();
  });

  it("rejects completion for a date other than the pending date", () => {
    const checkpoint: ZivaSyncCheckpoint = {
      version: 1,
      nextDate: "2026-04-02",
      endDate: "2026-04-04",
      recordsSynced: 5,
    };

    expect(() => advanceZivaSyncCheckpoint(checkpoint, "2026-04-03", 6)).toThrow();
  });

  it.each([
    ["fractional", 5.5],
    ["negative", -1],
    ["decreasing", 4],
  ])("rejects a %s cumulative record count", (_description, cumulativeRecordsSynced) => {
    const checkpoint: ZivaSyncCheckpoint = {
      version: 1,
      nextDate: "2026-04-02",
      endDate: "2026-04-04",
      recordsSynced: 5,
    };

    expect(() =>
      advanceZivaSyncCheckpoint(checkpoint, "2026-04-02", cumulativeRecordsSynced),
    ).toThrow();
  });

  it("rejects an invalid persisted checkpoint before advancing it", () => {
    const checkpoint: ZivaSyncCheckpoint = {
      version: 1,
      nextDate: "2026-04-05",
      endDate: "2026-04-04",
      recordsSynced: 5,
    };

    expect(() => advanceZivaSyncCheckpoint(checkpoint, "2026-04-05", 6)).toThrow();
  });
});

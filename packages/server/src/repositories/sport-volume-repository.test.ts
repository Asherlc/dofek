import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { SportVolumeRepository } from "./sport-volume-repository.ts";

const base = {
  id: "activity",
  sport: "running",
  modality: "outdoor",
  week: "2026-10-19",
  started_milliseconds: 0,
  duration_seconds: 60,
  distance_meters: 1000,
  elevation_meters: 10,
};
function repository(
  rows: object[],
  powerRows: object[] = [],
  queries: Record<string, unknown>[] = [],
  accessWindow: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" },
) {
  let calls = 0;
  return new SportVolumeRepository(
    {
      query: async <T extends z.ZodType>(
        schema: T,
        _query: string,
        params: Record<string, unknown> = {},
      ) => {
        queries.push(params);
        return (calls++ === 0 ? rows : powerRows).map((row) => schema.parse(row));
      },
    },
    "user",
    "UTC",
    accessWindow,
  );
}
describe("SportVolumeRepository aggregation", () => {
  it.each([
    ["time", "min"],
    ["distance", "km"],
    ["elevation", "m"],
  ] as const)("returns the selected %s metric with its display unit", async (metric, unit) => {
    const result = await repository([base]).getVolume({ days: null, sport: "running", metric });
    expect(result).toMatchObject({ sport: "running", metric, unit });
  });
  it("binds user, timezone, date range and the full access policy", async () => {
    const queries: Record<string, unknown>[] = [];
    await repository([base], [], queries).getVolume({
      days: null,
      sport: "running",
      metric: "time",
    });
    expect(queries).toEqual([
      {
        userId: "user",
        timezone: "UTC",
        days: null,
        accessFull: true,
        accessStart: null,
        accessEnd: null,
      },
    ]);
  });
  it("binds a limited access window together with the selected range", async () => {
    const queries: Record<string, unknown>[] = [];
    await repository([], [], queries, {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-10-20",
      endDateExclusive: "2026-10-27",
    }).getVolume({ days: 30, sport: "running", metric: "time" });
    expect(queries).toEqual([
      {
        userId: "user",
        timezone: "UTC",
        days: 30,
        accessFull: false,
        accessStart: "2026-10-20",
        accessEnd: "2026-10-27",
      },
    ]);
  });
  it("restricts totals to the chosen sport without loading power for other metrics", async () => {
    const queries: Record<string, unknown>[] = [];
    const result = await repository(
      [base, { ...base, id: "yoga", sport: "yoga", duration_seconds: 120 }],
      [],
      queries,
    ).getVolume({ days: null, sport: "running", metric: "time" });
    expect(result.weeks).toEqual([{ week: base.week, value: 1 }]);
    expect(queries).toHaveLength(1);
  });
  it("avoids a raw power query when the sport has no matching activities", async () => {
    const queries: Record<string, unknown>[] = [];
    expect(
      (
        await repository([base], [], queries).getVolume({
          days: null,
          sport: "cycling",
          metric: "work",
        })
      ).weeks,
    ).toEqual([]);
    expect(queries).toHaveLength(1);
  });
  it("sums nonzero work using activity-relative timestamps and a bounded power query", async () => {
    const queries: Record<string, unknown>[] = [];
    const result = await repository(
      [
        {
          ...base,
          sport: "cycling",
          modality: "indoor",
          started_milliseconds: 1000,
          duration_seconds: 3,
        },
      ],
      [
        {
          id: base.id,
          samples: [
            [3000, 200],
            [1000, 200],
            [2000, 200],
          ],
        },
      ],
      queries,
    ).getVolume({ days: null, sport: "cycling", metric: "work" });
    expect(result.weeks).toEqual([{ week: base.week, value: 0.6 }]);
    expect(result.unit).toBe("kJ");
    expect(queries[1]).toEqual({ userId: "user", activityIds: [base.id] });
  });
  it.each(["indoor", "virtual"])(
    "preserves unknown %s running distance while retaining time and elevation",
    async (modality) => {
      const rows = [{ ...base, modality, distance_meters: 0 }];
      expect(
        (await repository(rows).getVolume({ days: null, sport: "running", metric: "distance" }))
          .weeks[0]?.value,
      ).toBeNull();
      expect(
        (await repository(rows).getVolume({ days: null, sport: "running", metric: "time" }))
          .weeks[0]?.value,
      ).toBe(1);
      expect(
        (await repository(rows).getVolume({ days: null, sport: "running", metric: "elevation" }))
          .weeks[0]?.value,
      ).toBe(10);
    },
  );
  it("retains indoor cycling time and isolates outdoor-only metrics across weeks", async () => {
    const rows = [
      { ...base, sport: "cycling", modality: "indoor" },
      { ...base, sport: "cycling", week: "2026-10-26" },
    ];
    expect(
      (await repository(rows).getVolume({ days: null, sport: "cycling", metric: "time" })).weeks,
    ).toEqual([
      { week: base.week, value: 1 },
      { week: "2026-10-26", value: 1 },
    ]);
    expect(
      (await repository(rows).getVolume({ days: null, sport: "cycling", metric: "elevation" }))
        .weeks,
    ).toEqual([
      { week: base.week, value: null },
      { week: "2026-10-26", value: 10 },
    ]);
  });
  it("sums recorded time, distance and elevation independently by week", async () => {
    const rows = [
      base,
      { ...base, id: "second", duration_seconds: 120, distance_meters: 2000, elevation_meters: 20 },
      { ...base, id: "next-week", week: "2026-10-26" },
    ];
    expect(
      (await repository(rows).getVolume({ days: null, sport: "running", metric: "time" })).weeks,
    ).toEqual([
      { week: "2026-10-19", value: 3 },
      { week: "2026-10-26", value: 1 },
    ]);
    expect(
      (await repository(rows).getVolume({ days: null, sport: "running", metric: "distance" }))
        .weeks[0]?.value,
    ).toBe(3);
    expect(
      (await repository(rows).getVolume({ days: null, sport: "running", metric: "elevation" }))
        .weeks[0]?.value,
    ).toBe(30);
  });
  it("retains unknown totals regardless of whether the missing record comes first or last", async () => {
    const missing = {
      ...base,
      duration_seconds: null,
      distance_meters: null,
      elevation_meters: null,
    };
    for (const rows of [
      [missing, base],
      [base, missing],
    ]) {
      for (const metric of ["time", "distance", "elevation"] as const)
        expect(
          (await repository(rows).getVolume({ days: 30, sport: "running", metric })).weeks,
        ).toEqual([{ week: "2026-10-19", value: null }]);
    }
  });
  it("distinguishes measured zero from invalid negative measurements", async () => {
    expect(
      (
        await repository([{ ...base, distance_meters: 0 }]).getVolume({
          days: null,
          metric: "distance",
        })
      ).weeks[0]?.value,
    ).toBe(0);
    expect(
      (
        await repository([{ ...base, distance_meters: -1 }]).getVolume({
          days: null,
          metric: "distance",
        })
      ).weeks[0]?.value,
    ).toBeNull();
  });
  it("selects sports deterministically and supplies an empty time chart with no activities", async () => {
    expect(
      (
        await repository([{ ...base, sport: "yoga" }, base]).getVolume({
          days: null,
          metric: "time",
        })
      ).sport,
    ).toBe("running");
    expect(await repository([]).getVolume({ days: null, metric: "time" })).toMatchObject({
      sport: null,
      sports: [],
      weeks: [],
      unit: "min",
    });
    await expect(
      repository([base]).getVolume({ days: null, sport: "yoga", metric: "work" }),
    ).rejects.toThrow("not supported");
  });
  it("counts only outdoor distance and elevation in mixed cycling weeks", async () => {
    const rows = [
      { ...base, sport: "cycling" },
      {
        ...base,
        sport: "cycling",
        modality: "indoor",
        distance_meters: 50000,
        elevation_meters: 500,
      },
      { ...base, sport: "cycling", modality: "virtual" },
    ];
    expect(
      (await repository(rows).getVolume({ days: null, sport: "cycling", metric: "distance" }))
        .weeks[0]?.value,
    ).toBe(1);
    expect(
      (await repository(rows).getVolume({ days: null, sport: "cycling", metric: "elevation" }))
        .weeks[0]?.value,
    ).toBe(10);
    expect(
      (
        await repository(rows.slice(1)).getVolume({
          days: null,
          sport: "cycling",
          metric: "distance",
        })
      ).weeks[0]?.value,
    ).toBeNull();
  });
  it("withholds mechanical work for missing or discontinuous power and preserves recorded zero", async () => {
    const cycling = { ...base, sport: "cycling", duration_seconds: 3 };
    for (const duration_seconds of [null, 0, -1])
      expect(
        (
          await repository([{ ...cycling, duration_seconds }]).getVolume({
            days: null,
            sport: "cycling",
            metric: "work",
          })
        ).weeks[0]?.value,
      ).toBeNull();
    expect(
      (await repository([cycling]).getVolume({ days: null, sport: "cycling", metric: "work" }))
        .weeks[0]?.value,
    ).toBeNull();
    expect(
      (
        await repository([cycling], [{ id: base.id, samples: [[0, 200]] }]).getVolume({
          days: null,
          sport: "cycling",
          metric: "work",
        })
      ).weeks[0]?.value,
    ).toBeNull();
    expect(
      (
        await repository(
          [cycling],
          [
            {
              id: base.id,
              samples: [
                [2000, 0],
                [0, 0],
                [1000, 0],
              ],
            },
          ],
        ).getVolume({ days: null, sport: "cycling", metric: "work" })
      ).weeks[0]?.value,
    ).toBe(0);
  });
  it("does not bridge explicitly missing or invalid power samples", async () => {
    const cycling = { ...base, sport: "cycling", duration_seconds: 3 };
    for (const missing of [null, -1]) {
      const result = await repository(
        [cycling],
        [
          {
            id: base.id,
            samples: [
              [0, 200],
              [1000, missing],
              [2000, 200],
            ],
          },
        ],
      ).getVolume({ days: null, sport: "cycling", metric: "work" });
      expect(result.weeks[0]?.value).toBeNull();
    }
  });
});

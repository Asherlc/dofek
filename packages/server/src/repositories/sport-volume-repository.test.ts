import { describe, expect, it } from "vitest";
import type { z } from "zod";
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
function repository(rows: object[], powerRows: object[] = []) {
  let calls = 0;
  return new SportVolumeRepository(
    {
      query: async <T extends z.ZodType>(schema: T) =>
        (calls++ === 0 ? rows : powerRows).map((row) => schema.parse(row)),
    },
    "user",
    "UTC",
    { kind: "full", paid: true, reason: "paid_grant" },
  );
}
describe("SportVolumeRepository aggregation", () => {
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

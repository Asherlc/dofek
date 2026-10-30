import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RunningDynamicsActivity, RunningRepository } from "../repositories/running-repository.ts";
import { type Context, requestCacheKey, router } from "../trpc.ts";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock("dofek/lib/cache", () => ({
  queryCache: {
    get: vi.fn(async (key: string) => cache.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
    }),
    invalidate: vi.fn(async (key: string) => {
      cache.delete(key);
    }),
  },
}));
beforeEach(() => cache.clear());

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import { runningRouter } from "./running.ts";

const createCaller = createTestCallerFactory(runningRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  const execute = vi
    .fn()
    .mockImplementation(async () =>
      rows.flatMap((row) => (row.activity_id != null ? [{ id: String(row.activity_id) }] : [])),
    );
  const sensorStore = makeMockSensorStore(rows);
  vi.mocked(sensorStore.query).mockImplementation(async (schema) =>
    rows.map((row) => schema.parse(row)),
  );
  return createCaller({
    db: { execute },
    userId: "user-1",
    timezone: "UTC",
    sensorStore,
  });
}

describe("runningRouter", () => {
  it("counts cadence separately from optional form rows and describes missing interval evidence", async () => {
    const caller = makeCaller([
      {
        activity_id: "run-form",
        date: "2026-10-01",
        name: null,
        avg_cadence: null,
        cadence_basis: "unknown",
        cadence_observed_seconds: null,
        cadence_coverage_percent: null,
        avg_stride_length: null,
        avg_stance_time: 240,
        avg_vertical_osc: null,
        avg_speed: null,
        total_distance: null,
      },
    ]);
    await expect(caller.dynamicsV2({ days: 90, responseVersion: 2 })).resolves.toMatchObject({
      data: [
        {
          activityName: "Running",
          cadence: null,
          paceSecondsPerKm: null,
          distanceKm: null,
          stanceTimeMs: 240,
        },
      ],
      availability: { observedCount: 1 },
      cadenceAvailability: {
        observedCount: 0,
        message: expect.stringContaining("imported step intervals"),
      },
    });
  });

  describe("dynamics", () => {
    it("returns empty when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.dynamics({ days: 90 });
      expect(result).toEqual([]);
    });

    it("maps running dynamics fields correctly", async () => {
      const rows = [
        {
          activity_id: "run-1",
          date: "2026-01-15",
          name: "Morning Run",
          avg_cadence: 172,
          cadence_basis: "cadence_samples",
          cadence_observed_seconds: null,
          cadence_coverage_percent: null,
          avg_stride_length: 1.15,
          avg_stance_time: 245,
          avg_vertical_osc: 8.2,
          avg_speed: 3.5,
          total_distance: 8500,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.dynamics({ days: 90, responseVersion: 2 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        activityId: "run-1",
        date: "2026-01-15",
        activityName: "Morning Run",
        cadence: 172,
        cadenceBasis: "cadence_samples",
        cadenceObservedSeconds: null,
        cadenceCoveragePercent: null,
        strideLengthMeters: 1.15,
        stanceTimeMs: 245,
        verticalOscillationMm: 8.2,
        paceSecondsPerKm: 286, // 1000 / 3.5 ≈ 285.7 → rounds to 286
        distanceKm: 8.5,
      });
    });

    it("returns multiple activities sorted by date", async () => {
      const rows = [
        {
          activity_id: "run-2",
          date: "2026-01-10",
          name: "Easy Run",
          avg_cadence: 168,
          cadence_basis: "cadence_samples",
          cadence_observed_seconds: null,
          cadence_coverage_percent: null,
          avg_stride_length: 1.1,
          avg_stance_time: 260,
          avg_vertical_osc: 9.0,
          avg_speed: 3.0,
          total_distance: 5000,
        },
        {
          activity_id: "run-3",
          date: "2026-01-12",
          name: "Tempo Run",
          avg_cadence: 178,
          cadence_basis: "cadence_samples",
          cadence_observed_seconds: null,
          cadence_coverage_percent: null,
          avg_stride_length: 1.25,
          avg_stance_time: 230,
          avg_vertical_osc: 7.5,
          avg_speed: 4.0,
          total_distance: 10000,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.dynamics({ days: 90 });

      expect(result).toHaveLength(2);
      expect(result[0]?.activityName).toBe("Easy Run");
      expect(result[1]?.activityName).toBe("Tempo Run");
    });

    it("handles null stride length gracefully", async () => {
      const rows = [
        {
          activity_id: "run-4",
          date: "2026-01-15",
          name: "Treadmill",
          avg_cadence: 170,
          cadence_basis: "cadence_samples",
          cadence_observed_seconds: null,
          cadence_coverage_percent: null,
          avg_stride_length: null,
          avg_stance_time: null,
          avg_vertical_osc: null,
          avg_speed: 3.2,
          total_distance: 6000,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.dynamics({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.strideLengthMeters).toBeNull();
      expect(result[0]?.stanceTimeMs).toBeNull();
      expect(result[0]?.verticalOscillationMm).toBeNull();
    });
  });

  describe("paceTrend", () => {
    it("returns empty when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.paceTrend({ days: 90 });
      expect(result).toEqual([]);
    });

    it("returns pace trend data", async () => {
      const rows = [
        {
          activity_id: "run-pace-1",
          date: "2026-01-15",
          name: "Morning Run",
          avg_speed: 3.5,
          total_distance: 8500,
          duration_seconds: 2400,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.paceTrend({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        date: "2026-01-15",
        activityName: "Morning Run",
        paceSecondsPerKm: 286,
        distanceKm: 8.5,
        durationMinutes: 40,
      });
    });

    it("returns multiple runs", async () => {
      const rows = [
        {
          activity_id: "run-pace-1",
          date: "2026-01-10",
          name: "Easy",
          avg_speed: 3.0,
          total_distance: 5000,
          duration_seconds: 1667,
        },
        {
          activity_id: "run-pace-2",
          date: "2026-01-12",
          name: "Tempo",
          avg_speed: 4.0,
          total_distance: 10000,
          duration_seconds: 2500,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.paceTrend({ days: 90 });

      expect(result).toHaveLength(2);
      // Faster run should have lower pace (fewer seconds per km)
      expect(result[1]?.paceSecondsPerKm).toBeLessThan(result[0]?.paceSecondsPerKm ?? Infinity);
    });

    it("returns server-owned availability facts without changing the legacy array endpoint", async () => {
      const caller = makeCaller([]);

      await expect(caller.paceTrendV2({ days: 90 })).resolves.toMatchObject({
        data: [],
        availability: {
          status: "insufficient_data",
          sourceLabel: "Running activity sensor summaries",
          observedCount: 0,
          minimumCount: 1,
          message: expect.stringContaining("Record at least 1 running activity"),
        },
      });
      await expect(caller.paceTrend({ days: 90 })).resolves.toEqual([]);
    });
  });

  it("returns available dynamics data through the versioned contract", async () => {
    const caller = makeCaller([
      {
        activity_id: "run-1",
        date: new Date("2026-01-15T00:00:00Z"),
        name: "Morning Run",
        avg_cadence: 172,
        cadence_basis: "cadence_samples",
        cadence_observed_seconds: null,
        cadence_coverage_percent: null,
        avg_stride_length: 1.15,
        avg_stance_time: 245,
        avg_vertical_osc: 8.2,
        avg_speed: 3.5,
        total_distance: 8500,
      },
    ]);

    await expect(caller.dynamicsV2({ days: 90, responseVersion: 2 })).resolves.toMatchObject({
      data: [expect.objectContaining({ activityId: "run-1", date: "2026-01-15" })],
      availability: {
        status: "available",
        observedCount: 1,
        minimumCount: 1,
        message: "Running form measurements are available.",
      },
    });
  });

  it("returns available pace trend data through the versioned contract", async () => {
    const caller = makeCaller([
      {
        activity_id: "run-pace-1",
        date: "2026-01-15",
        name: "Morning Run",
        avg_speed: 3.5,
        total_distance: 8500,
        duration_seconds: 2400,
      },
    ]);

    await expect(caller.paceTrendV2({ days: 90 })).resolves.toMatchObject({
      data: [
        {
          date: "2026-01-15",
          activityName: "Morning Run",
          paceSecondsPerKm: 286,
        },
      ],
      availability: {
        status: "available",
        observedCount: 1,
        minimumCount: 1,
        message: "running pace data is available from Running activity sensor summaries.",
      },
    });
  });
});

const completeRow = {
  activity_id: "complete",
  date: "2026-10-01",
  name: "Complete run",
  avg_cadence: 170,
  cadence_basis: "step_intervals",
  cadence_observed_seconds: 180,
  cadence_coverage_percent: 30,
  avg_stride_length: null,
  avg_stance_time: 240,
  avg_vertical_osc: null,
  avg_speed: 4,
  total_distance: 5000,
};
const mixedRows = [
  completeRow,
  { ...completeRow, activity_id: "form", avg_cadence: null, avg_speed: null, total_distance: null },
  { ...completeRow, activity_id: "no-cadence", avg_cadence: null },
  { ...completeRow, activity_id: "no-pace", avg_speed: null },
  { ...completeRow, activity_id: "no-distance", total_distance: null },
];
const historicalRow = {
  activityId: "complete",
  date: "2026-10-01",
  activityName: "Complete run",
  cadence: 170,
  strideLengthMeters: null,
  stanceTimeMs: 240,
  verticalOscillationMm: null,
  paceSecondsPerKm: 250,
  distanceKm: 5,
};
describe("running response negotiation", () => {
  for (const procedure of ["dynamics", "dynamicsV2"] as const) {
    it(`${procedure} returns current empty data with server availability`, async () => {
      const result = await makeCaller()[procedure]({ responseVersion: 2 });
      expect(Array.isArray(result) ? result : result.data).toEqual([]);
      if (!Array.isArray(result))
        expect(result).toMatchObject({
          availability: {
            status: "insufficient_data",
            observedCount: 0,
            message:
              "No running form measurements are available for these runs. Check the selected range and sync status.",
          },
          cadenceAvailability: {
            status: "insufficient_data",
            observedCount: 0,
            message: expect.stringContaining("imported step intervals"),
          },
        });
    });
    it.each([{}, { responseVersion: 1 }])(
      `${procedure} preserves historical numeric assumptions for %j`,
      async (input) => {
        const result = await makeCaller(mixedRows)[procedure](input);
        const rows = Array.isArray(result) ? result : result.data;
        expect(rows).toEqual([historicalRow]);
        expect(
          rows.map((row: typeof historicalRow) => [
            row.cadence.toFixed(0),
            row.paceSecondsPerKm.toFixed(0),
            row.distanceKm.toFixed(1),
          ]),
        ).toEqual([["170", "250", "5.0"]]);
        if (!Array.isArray(result))
          expect(result).toEqual({
            data: [historicalRow],
            availability: {
              status: "available",
              sourceLabel: "Running activity sensor summaries",
              observedCount: 1,
              minimumCount: 1,
              message: "running dynamics data is available from Running activity sensor summaries.",
            },
          });
      },
    );
    it(`${procedure} keeps complete nullable rows for version 2`, async () => {
      const result = await makeCaller(mixedRows)[procedure]({ days: null, responseVersion: 2 });
      const rows = Array.isArray(result) ? result : result.data;
      expect(rows).toHaveLength(5);
      expect(rows[1]).toMatchObject({
        cadence: null,
        paceSecondsPerKm: null,
        distanceKm: null,
        cadenceBasis: "step_intervals",
      });
      if (!Array.isArray(result))
        expect(result).toMatchObject({
          availability: { observedCount: 5 },
          cadenceAvailability: { observedCount: 3 },
        });
    });
    it.each([0, 3, "2"])(`${procedure} rejects invalid version %s`, async (responseVersion) => {
      await expect(makeCaller()[procedure]({ responseVersion })).rejects.toThrow();
    });
    it(`${procedure} omits only partial rows and preserves measured zeros`, async () => {
      const result = await makeCaller([{ ...completeRow, avg_cadence: 0, total_distance: 0 }])[
        procedure
      ]({ days: 30 });
      const rows = Array.isArray(result) ? result : result.data;
      expect(rows).toEqual([{ ...historicalRow, cadence: 0, distanceKm: 0 }]);
      cache.clear();
      const partial = await makeCaller(mixedRows.slice(1))[procedure]({});
      expect(Array.isArray(partial) ? partial : partial.data).toEqual([]);
      if (!Array.isArray(partial))
        expect(partial.availability).toMatchObject({
          status: "insufficient_data",
          observedCount: 0,
        });
    });
  }
});

const transportRouter = router({ running: runningRouter });
describe("cold running GET cache negotiation", () => {
  for (const procedure of ["dynamics", "dynamicsV2"] as const) {
    it.each([false, true])(
      `${procedure} separates cold versions (current first: %s)`,
      async (currentFirst) => {
        const sensorStore = makeMockSensorStore(mixedRows);
        const execute = vi.fn(async () => mixedRows.map((row) => ({ id: row.activity_id })));
        const ctx = z.custom<Context>().parse({
          db: { execute },
          userId: "transport-user",
          timezone: "UTC",
          sensorStore,
        });
        const path = `running.${procedure}`;
        const oldKey = requestCacheKey(
          ctx.userId,
          path,
          {},
          ctx.timezone,
          "running-cadence-evidence-v1",
        );
        cache.set(oldKey, procedure === "dynamics" ? [{ poisoned: true }] : { poisoned: true });
        const request = async (input: Record<string, unknown>) => {
          const response = await fetchRequestHandler({
            endpoint: "/trpc",
            router: transportRouter,
            req: new Request(
              "http://unit.test/trpc/" +
                path +
                "?input=" +
                encodeURIComponent(JSON.stringify(input)),
            ),
            createContext: () => ctx,
          });
          expect(response.status).toBe(200);
          const json = await response.json();
          return json.result.data;
        };
        const legacy = async (input: Record<string, unknown>) => {
          const response = await request(input);
          expect(procedure === "dynamics" ? response : response.data).toEqual([historicalRow]);
          if (procedure === "dynamicsV2") expect(response.availability.observedCount).toBe(1);
        };
        const current = async () => {
          const response = await request({ responseVersion: 2 });
          const rows = procedure === "dynamics" ? response : response.data;
          expect(rows).toHaveLength(5);
          expect(rows[1]).toMatchObject({
            cadence: null,
            paceSecondsPerKm: null,
            distanceKm: null,
          });
          if (procedure === "dynamicsV2")
            expect(response.cadenceAvailability.observedCount).toBe(3);
        };
        if (currentFirst) {
          await current();
          await legacy({});
        } else {
          await legacy({});
          await current();
        }
        expect(sensorStore.query).toHaveBeenCalledTimes(2);
        await legacy({});
        await current();
        expect(sensorStore.query).toHaveBeenCalledTimes(2);
        await legacy({ responseVersion: 1 });
        expect(sensorStore.query).toHaveBeenCalledTimes(3);
        const otherPath = procedure === "dynamics" ? "running.dynamicsV2" : "running.dynamics";
        const otherResponse = await fetchRequestHandler({
          endpoint: "/trpc",
          router: transportRouter,
          req: new Request(
            "http://unit.test/trpc/" +
              otherPath +
              "?input=" +
              encodeURIComponent(JSON.stringify({ responseVersion: 2 })),
          ),
          createContext: () => ctx,
        });
        expect(otherResponse.status).toBe(200);
        expect(sensorStore.query).toHaveBeenCalledTimes(4);
        expect(
          cache.has(
            requestCacheKey(ctx.userId, path, {}, ctx.timezone, "running-response-negotiation-v1"),
          ),
        ).toBe(true);
        expect(cache.has(oldKey)).toBe(true);
      },
    );
  }
});

describe("running versioned input/output boundaries", () => {
  for (const procedure of ["dynamics", "dynamicsV2"] as const) {
    it.each([
      { input: {}, days: 90 },
      { input: { days: 30 }, days: 30 },
      { input: { days: null }, days: null },
    ])(`${procedure} forwards the selected range %j`, async ({ input, days }) => {
      const spy = vi.spyOn(RunningRepository.prototype, "getDynamics");
      try {
        await makeCaller(mixedRows)[procedure](input);
        expect(spy).toHaveBeenCalledWith(days);
      } finally {
        spy.mockRestore();
      }
    });
    it(`${procedure} preserves the required whole-input object`, async () => {
      await expect(makeCaller()[procedure]()).rejects.toThrow();
    });
    it(`${procedure} validates current output without downgrading malformed metadata`, async () => {
      const detail = {
        ...historicalRow,
        cadenceBasis: "cadence_samples" as const,
        cadenceObservedSeconds: 180,
        cadenceCoveragePercent: 30,
      };
      Reflect.set(detail, "cadenceBasis", "invalid");
      const spy = vi
        .spyOn(RunningDynamicsActivity.prototype, "toDetail")
        .mockReturnValueOnce(detail);
      try {
        await expect(makeCaller([completeRow])[procedure]({ responseVersion: 2 })).rejects.toThrow(
          "Output validation failed",
        );
      } finally {
        spy.mockRestore();
      }
    });
    it(`${procedure} projects nonfinite required metrics only at the legacy boundary`, async () => {
      const detail = {
        ...historicalRow,
        cadence: Infinity,
        cadenceBasis: "cadence_samples" as const,
        cadenceObservedSeconds: null,
        cadenceCoveragePercent: null,
      };
      const spy = vi.spyOn(RunningDynamicsActivity.prototype, "toDetail").mockReturnValue(detail);
      try {
        const result = await makeCaller([completeRow])[procedure]({});
        expect(Array.isArray(result) ? result : result.data).toEqual([]);
        await expect(makeCaller([completeRow])[procedure]({ responseVersion: 2 })).rejects.toThrow(
          "Output validation failed",
        );
      } finally {
        spy.mockRestore();
      }
    });
  }
});

import type { AnyRouter } from "@trpc/server";
import { initTRPC } from "@trpc/server";
import { sql } from "drizzle-orm";
import { vi } from "vitest";
import type { z } from "zod";
import type {
  ProviderDataGenerationContext,
  ProviderDataScope,
} from "../../../../src/db/provider-data-deletion.ts";
import type { Database } from "../../../../src/db/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import type { Context } from "../trpc.ts";

const trpc = initTRPC.context<Context>().create();

export async function resolveProviderDataGenerationsForTest(
  database: Database,
  scopes: readonly ProviderDataScope[],
): Promise<ProviderDataGenerationContext> {
  await database.execute(sql`SELECT 0 AS generation`);
  return {
    generations: scopes.map((scope) => ({ ...scope, generation: 0 })),
    operationRevision: "1000000000000000",
  };
}

export function makeTransactionalTestDatabase<TDatabase extends Database>(
  database: TDatabase,
): TDatabase & {
  transaction<TResult>(work: (transaction: TDatabase) => Promise<TResult>): Promise<TResult>;
} {
  async function transaction<TResult>(
    work: (transaction: TDatabase) => Promise<TResult>,
  ): Promise<TResult> {
    return work(database);
  }
  return Object.assign(database, { transaction });
}

export function createTestCallerFactory(router: AnyRouter) {
  return trpc.createCallerFactory(router);
}

type MockTestDatabase = {
  execute: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

export function makeTestCaller<TContext, TCaller>(
  createCaller: (context: TContext) => TCaller,
  responses: unknown[][] = [],
  createContext: (db: MockTestDatabase) => TContext,
) {
  const execute = vi.fn();
  for (const response of responses) execute.mockResolvedValueOnce(response);
  execute.mockResolvedValue([]);
  const db: MockTestDatabase = { execute, transaction: vi.fn() };
  db.transaction.mockImplementation(async (callback) => callback(db));
  return { caller: createCaller(createContext(db)), execute };
}

export function collectSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const queryChunks = Reflect.get(value, "queryChunks");
  if (Array.isArray(queryChunks)) {
    return queryChunks.map((queryChunk) => collectSqlText(queryChunk)).join("");
  }
  const rawValue = Reflect.get(value, "value");
  if (Array.isArray(rawValue)) {
    return rawValue.map((rawChunk) => collectSqlText(rawChunk)).join("");
  }
  if (typeof rawValue === "string") return rawValue;
  return "";
}

/**
 * Construct an in-memory ActivitySensorStore that returns `rows` (or successive
 * row sets if `rows` is an array of arrays) from `query()`. All other store
 * methods stub out to empty arrays. Use in router/repo tests that exercise
 * code paths reading from analytics.activity_summary / analytics.deduped_sensor.
 */
function isMatrix(rows: unknown[] | unknown[][]): rows is unknown[][] {
  return rows.length > 0 && Array.isArray(rows[0]);
}

function isRows<T>(value: unknown): value is T[] {
  return Array.isArray(value);
}

export function makeMockSensorStore(rows: unknown[] | unknown[][] = []): ActivitySensorStore {
  const rowBatches = isMatrix(rows) ? [...rows] : undefined;
  const queryTarget: Pick<ActivitySensorStore, "query"> = {
    query: async <TSchema extends z.ZodType>(_schema: TSchema): Promise<z.infer<TSchema>[]> => {
      const batch = rowBatches ? (rowBatches.shift() ?? []) : rows;
      return isRows<z.infer<TSchema>>(batch) ? batch : [];
    },
  };
  vi.spyOn(queryTarget, "query");
  return {
    query: queryTarget.query,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
    refreshBodyMeasurements: vi.fn().mockResolvedValue(undefined),
  };
}

export function metricRow(
  overrides: Partial<{
    date: string;
    hrv: number | null;
    resting_hr: number | null;
    respiratory_rate: number | null;
    efficiency_pct: number | null;
    hrv_mean_30d: number | null;
    hrv_sd_30d: number | null;
    rhr_mean_30d: number | null;
    rhr_sd_30d: number | null;
    rr_mean_30d: number | null;
    rr_sd_30d: number | null;
    daily_load: number;
  }> = {},
) {
  return {
    date: "2026-03-28",
    hrv: null,
    resting_hr: null,
    respiratory_rate: null,
    efficiency_pct: null,
    hrv_mean_30d: null,
    hrv_sd_30d: null,
    rhr_mean_30d: null,
    rhr_sd_30d: null,
    rr_mean_30d: null,
    rr_sd_30d: null,
    daily_load: 0,
    ...overrides,
  };
}

export function sleepBaselineRow(
  date: string,
  durationMinutes: number,
  hrv: number | null,
  load = 0,
) {
  return {
    date,
    duration_minutes: durationMinutes,
    hrv,
    yesterday_load: load,
  };
}

export function dateDaysBefore(dateString: string, daysBefore: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysBefore);
  return date.toISOString().slice(0, 10);
}

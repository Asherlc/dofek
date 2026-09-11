import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { z } from "zod";
import type { ClickHouseClient } from "../../../../src/db/clickhouse.ts";
import { nutrientAmountEntriesFromLegacyFields } from "../../../../src/db/nutrient-columns.ts";
import type {
  ProviderDataGenerationContext,
  ProviderDataScope,
} from "../../../../src/db/provider-data-deletion.ts";
import {
  supplement,
  supplementDefinition,
  supplementDefinitionNutrient,
} from "../../../../src/db/schema/nutrition.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const PERFORMANCE_COMPARISON_SERVING_TABLES = [
  [
    "activity_effort_identity",
    "canonical_activity_id UUID, source_activity_id UUID, source_provider String, source_external_id Nullable(String), kind String, namespace String, value String, normalized_value String, display_name Nullable(String), strength String, method String, source_field String, evidence Map(String,String)",
    "user_id, source_activity_id, kind, namespace, normalized_value, source_field",
  ],
  [
    "activity_route_identity",
    "canonical_activity_id UUID, route_fingerprint Nullable(String), points Array(Tuple(Float64,Float64)), route_distance_meters Nullable(Float64), elevation_profile Array(Float64), coverage_pct Nullable(Float64), largest_gap_seconds Nullable(Float64), geometry_status String, source_providers Array(String), source_devices Array(String)",
    "user_id, canonical_activity_id",
  ],
  [
    "deduped_activities",
    "activity_id UUID, started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC'))",
    "user_id, activity_id",
  ],
  [
    "activity_power_curve",
    "activity_id UUID, duration_seconds UInt32, best_power Float64, start_offset_seconds Nullable(Float64), observed_samples Nullable(UInt32), coverage_pct Nullable(Float64), largest_gap_seconds Nullable(Float64), median_sample_interval_seconds Nullable(Float64), power_measurement_kind Nullable(String)",
    "user_id, activity_id, duration_seconds",
  ],
  [
    "v_body_measurement",
    "recorded_at DateTime64(6, 'UTC'), weight_kg Nullable(Float64), provider_id String, external_id Nullable(String)",
    "user_id, recorded_at",
  ],
] as const;

export function createScopedActivitySensorStoreForTest(
  clickhouse: ClickHouseClient,
  analyticsDatabase: string,
): Pick<ActivitySensorStore, "query"> {
  return {
    async query<TSchema extends z.ZodType>(
      schema: TSchema,
      query: string,
      params?: Record<string, unknown>,
    ): Promise<z.infer<TSchema>[]> {
      const result = await clickhouse.query({
        query: query.replaceAll("analytics.", `${analyticsDatabase}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      return z.array(schema).parse(await result.json());
    },
  };
}

export async function createPerformanceComparisonServingTablesForTest(
  clickhouse: ClickHouseClient,
  analyticsDatabase: string,
): Promise<void> {
  for (const [name, columns, order] of PERFORMANCE_COMPARISON_SERVING_TABLES) {
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.${name} (user_id UUID, ${columns}, refresh_version UInt64, is_deleted UInt8) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (${order})`,
    });
  }
}

export async function insertSupplementDefinitionForTest(
  database: Database,
  values: {
    userId: string;
    name: string;
    effectiveFrom: string;
    meal?: "breakfast" | "lunch" | "dinner" | "snack" | "other";
  },
  nutrients: Record<string, number | null> = {},
): Promise<{ definitionId: string; scheduleId: string }> {
  const [insertedSchedule] = await database
    .insert(supplement)
    .values({ userId: values.userId })
    .returning({ id: supplement.id });
  if (!insertedSchedule) throw new Error("Supplement fixture schedule insert returned no id");

  const [insertedDefinition] = await database
    .insert(supplementDefinition)
    .values({
      supplementId: insertedSchedule.id,
      name: values.name,
      effectiveFrom: values.effectiveFrom,
      meal: values.meal,
    })
    .returning({ id: supplementDefinition.id });
  if (!insertedDefinition) throw new Error("Supplement fixture definition insert returned no id");

  const nutrientEntries = nutrientAmountEntriesFromLegacyFields(nutrients);
  if (nutrientEntries.length > 0) {
    await database.insert(supplementDefinitionNutrient).values(
      nutrientEntries.map((nutrient) => ({
        definitionId: insertedDefinition.id,
        nutrientId: nutrient.nutrientId,
        amount: nutrient.amount,
      })),
    );
  }

  return {
    definitionId: insertedDefinition.id,
    scheduleId: insertedSchedule.id,
  };
}

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

export function expectClickHouseFiniteDaysFilter(
  query: string | undefined,
  params: Record<string, unknown> | undefined,
  expectedDays = 30,
): void {
  expect(query).toContain("INTERVAL {days:Int32} DAY");
  expect(params).toHaveProperty("days", expectedDays);
}

export function expectClickHouseUnboundedDaysFilter(
  query: string | undefined,
  params: Record<string, unknown> | undefined,
): void {
  expect(query).not.toContain("INTERVAL {days:Int32} DAY");
  expect(params).not.toHaveProperty("days");
}

export function expectSensorStoreFiniteDaysFilter(
  sensorStore: {
    query: {
      mock: { calls: Array<[unknown, string | undefined, Record<string, unknown> | undefined]> };
    };
  },
  callIndex = 0,
  expectedDays = 30,
): void {
  const call = sensorStore.query.mock.calls[callIndex];
  expect(call).toBeDefined();
  if (!call) return;
  const [, query, params] = call;
  expectClickHouseFiniteDaysFilter(query, params, expectedDays);
}

export function expectSensorStoreUnboundedDaysFilter(
  sensorStore: {
    query: {
      mock: { calls: Array<[unknown, string | undefined, Record<string, unknown> | undefined]> };
    };
  },
  callIndex = 0,
): void {
  const call = sensorStore.query.mock.calls[callIndex];
  expect(call).toBeDefined();
  if (!call) return;
  const [, query, params] = call;
  expectClickHouseUnboundedDaysFilter(query, params);
}

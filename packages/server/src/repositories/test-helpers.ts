import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
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

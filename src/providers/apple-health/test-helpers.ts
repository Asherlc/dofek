import { sql } from "drizzle-orm";
import type {
  ProviderDataGenerationContext,
  ProviderDataScope,
} from "../../db/provider-data-deletion.ts";
import type { Database } from "../../db/typed-sql.ts";
import type { HealthRecord } from "./records.ts";
import type { HangTenActivitySegment, HealthWorkout } from "./workouts.ts";

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

export function healthRecord(
  type: string,
  value: number,
  startDate: Date,
  unit: string,
  sourceName = "Apple Watch",
): HealthRecord {
  return {
    type,
    sourceName,
    unit,
    value,
    startDateCalendarDay: startDate.toISOString().slice(0, 10),
    startDate,
    endDate: startDate,
    creationDate: startDate,
  };
}

export function hangTenActivitySegments(): HangTenActivitySegment[] {
  return [
    {
      stepID: "step-1",
      stepNumber: 1,
      kind: "work",
      holdIDs: ["edge-19"],
      holdType: "edge",
      sizeMillimeters: 19,
      durationSeconds: 7,
    },
    {
      stepID: "step-1-rest",
      stepNumber: 1,
      kind: "rest",
      holdIDs: [],
      durationSeconds: 3,
    },
  ];
}

export function hangTenWorkout(overrides: Partial<HealthWorkout> = {}): HealthWorkout {
  const startDate = overrides.startDate ?? new Date("2026-08-07T14:00:00Z");
  return {
    activityType: {
      canonicalType: "hangboard",
      providerType: "Hang Ten",
      modality: null,
    },
    sourceName: "Hang Ten",
    durationSeconds: 10,
    startDate,
    endDate: overrides.endDate ?? new Date(startDate.getTime() + 10_000),
    hangTen: {
      sessionId: "22222222-2222-4222-8222-222222222222",
      planName: "Repeaters",
      activitySegments: hangTenActivitySegments(),
    },
    ...overrides,
  };
}

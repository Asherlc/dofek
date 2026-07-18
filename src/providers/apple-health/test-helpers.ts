import { sql } from "drizzle-orm";
import type { ProviderDataGeneration, ProviderDataScope } from "../../db/provider-data-deletion.ts";
import type { Database } from "../../db/typed-sql.ts";
import type { HealthRecord } from "./records.ts";

export async function resolveProviderDataGenerationsForTest(
  database: Database,
  scopes: readonly ProviderDataScope[],
): Promise<ProviderDataGeneration[]> {
  await database.execute(sql`SELECT 0 AS generation`);
  return scopes.map((scope) => ({ ...scope, generation: 0 }));
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

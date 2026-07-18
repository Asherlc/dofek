import { sql } from "drizzle-orm";
import type { ProviderDataGeneration, ProviderDataScope } from "../../db/provider-data-deletion.ts";
import type { Database } from "../../db/typed-sql.ts";

export async function resolveProviderDataGenerationsForTest(
  database: Database,
  scopes: readonly ProviderDataScope[],
): Promise<ProviderDataGeneration[]> {
  await database.execute(sql`SELECT 0 AS generation`);
  return scopes.map((scope) => ({ ...scope, generation: 0 }));
}

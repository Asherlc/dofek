import { sql } from "drizzle-orm";
import type {
  ProviderDataGenerationContext,
  ProviderDataScope,
} from "../../db/provider-data-deletion.ts";
import type { Database } from "../../db/typed-sql.ts";

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

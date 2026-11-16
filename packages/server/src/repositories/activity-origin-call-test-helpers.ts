import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../../../../src/db/execute-with-schema.ts";
import type { TestContext } from "../../../../src/db/test-helpers.ts";

/** Count real resolver executions in an isolated test database, preserving its result. */
export async function countActivityOriginCalls<T>(
  context: TestContext,
  action: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
  const [original] = await executeWithSchema(
    context.db,
    z.object({ definition: z.string() }),
    sql`SELECT pg_get_functiondef('fitness.resolve_activity_origin(jsonb)'::regprocedure) AS definition`,
  );
  if (!original) throw new Error("Missing activity origin resolver");
  await context.db.execute(
    sql.raw(
      original.definition.replace(
        "fitness.resolve_activity_origin(",
        "fitness.test_resolve_activity_origin(",
      ),
    ),
  );
  await context.db.execute(sql`CREATE TABLE fitness.test_activity_origin_call (members jsonb)`);
  try {
    await context.db.execute(sql`CREATE OR REPLACE FUNCTION fitness.resolve_activity_origin(input_members jsonb)
      RETURNS TABLE (primary_activity_id uuid, primary_provider_id text, primary_source_name text,
        origin_candidate_member_ids uuid[], origin_evidence jsonb)
      LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE AS $$
      BEGIN
        INSERT INTO fitness.test_activity_origin_call(members) VALUES (input_members);
        RETURN QUERY SELECT * FROM fitness.test_resolve_activity_origin(input_members);
      END;
      $$`);
    const result = await action();
    const [observed] = await executeWithSchema(
      context.db,
      z.object({ calls: z.coerce.number() }),
      sql`SELECT count(*) AS calls FROM fitness.test_activity_origin_call`,
    );
    if (!observed) throw new Error("Missing resolver call count");
    return { result, calls: observed.calls };
  } finally {
    await context.db.execute(sql.raw(original.definition));
    await context.db.execute(sql`DROP FUNCTION fitness.test_resolve_activity_origin(jsonb)`);
    await context.db.execute(sql`DROP TABLE fitness.test_activity_origin_call`);
  }
}

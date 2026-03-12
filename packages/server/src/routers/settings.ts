import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export const settingsRouter = router({
  get: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute<{ key: string; value: unknown }>(
        sql`SELECT key, value FROM fitness.user_settings WHERE user_id = ${ctx.userId} AND key = ${input.key} LIMIT 1`,
      );
      const row = rows[0];
      if (!row) return null;
      return { key: row.key, value: row.value };
    }),

  getAll: cachedProtectedQuery(CacheTTL.LONG).query(async ({ ctx }) => {
    const rows = await ctx.db.execute<{ key: string; value: unknown }>(
      sql`SELECT key, value FROM fitness.user_settings WHERE user_id = ${ctx.userId} ORDER BY key`,
    );
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }),

  set: protectedProcedure
    .input(z.object({ key: z.string(), value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.execute<{ key: string; value: unknown }>(
        sql`INSERT INTO fitness.user_settings (user_id, key, value, updated_at)
            VALUES (${ctx.userId}, ${input.key}, ${JSON.stringify(input.value)}::jsonb, NOW())
            ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            RETURNING key, value`,
      );
      const result = rows[0];
      if (!result) throw new Error("Failed to upsert setting");
      return { key: result.key, value: result.value };
    }),
});

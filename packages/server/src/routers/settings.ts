import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedQuery, publicProcedure, router } from "../trpc.ts";

export const settingsRouter = router({
  get: cachedQuery(CacheTTL.LONG)
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute<{ key: string; value: unknown }>(
        sql`SELECT key, value FROM fitness.user_settings WHERE key = ${input.key} LIMIT 1`,
      );
      if (rows.length === 0) return null;
      return { key: rows[0].key, value: rows[0].value };
    }),

  getAll: cachedQuery(CacheTTL.LONG).query(async ({ ctx }) => {
    const rows = await ctx.db.execute<{ key: string; value: unknown }>(
      sql`SELECT key, value FROM fitness.user_settings ORDER BY key`,
    );
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }),

  set: publicProcedure
    .input(z.object({ key: z.string(), value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.execute<{ key: string; value: unknown }>(
        sql`INSERT INTO fitness.user_settings (key, value, updated_at)
            VALUES (${input.key}, ${JSON.stringify(input.value)}::jsonb, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            RETURNING key, value`,
      );
      return { key: rows[0].key, value: rows[0].value };
    }),
});

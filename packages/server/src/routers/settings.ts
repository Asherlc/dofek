import { sql } from "drizzle-orm";
import { z } from "zod";
import { queryCache } from "../lib/cache.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQueryLight, protectedProcedure, router } from "../trpc.ts";
import { DISCONNECT_CHILD_TABLES } from "./provider-detail.ts";

const USER_SCOPED_DELETE_TABLES = [
  "fitness.user_settings",
  "fitness.life_events",
  "fitness.sport_settings",
  "fitness.supplement",
];

const settingRowSchema = z.object({ key: z.string(), value: z.unknown() });

export const settingsRouter = router({
  get: cachedProtectedQueryLight(CacheTTL.LONG)
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        settingRowSchema,
        sql`SELECT key, value FROM fitness.user_settings WHERE user_id = ${ctx.userId} AND key = ${input.key} LIMIT 1`,
      );
      const row = rows[0];
      if (!row) return null;
      return { key: row.key, value: row.value };
    }),

  getAll: cachedProtectedQueryLight(CacheTTL.LONG).query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      settingRowSchema,
      sql`SELECT key, value FROM fitness.user_settings WHERE user_id = ${ctx.userId} ORDER BY key`,
    );
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }),

  set: protectedProcedure
    .input(z.object({ key: z.string(), value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        settingRowSchema,
        sql`INSERT INTO fitness.user_settings (user_id, key, value, updated_at)
            VALUES (${ctx.userId}, ${input.key}, ${JSON.stringify(input.value)}::jsonb, NOW())
            ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            RETURNING key, value`,
      );
      const result = rows[0];
      if (!result) throw new Error("Failed to upsert setting");

      // Invalidate server-side cache for settings.get and settings.getAll
      // so subsequent reads return the updated value, not stale cached data.
      await queryCache.invalidateByPrefix(`${ctx.userId}:settings.`);

      return { key: result.key, value: result.value };
    }),

  slackStatus: cachedProtectedQueryLight(CacheTTL.MEDIUM).query(async ({ ctx }) => {
    const slackRowSchema = z.object({ provider_account_id: z.string() });
    const rows = await executeWithSchema(
      ctx.db,
      slackRowSchema,
      sql`SELECT provider_account_id FROM fitness.auth_account
          WHERE user_id = ${ctx.userId} AND auth_provider = 'slack'
          LIMIT 1`,
    );
    const oauthMode = !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_SIGNING_SECRET);
    const socketMode = !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
    const configured = oauthMode || socketMode;
    return {
      configured,
      connected: rows.length > 0,
    };
  }),

  deleteAllUserData: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.transaction(async (tx) => {
      for (const table of DISCONNECT_CHILD_TABLES) {
        await tx.execute(
          sql`DELETE FROM ${sql.raw(table)}
              WHERE provider_id IN (
                SELECT id FROM fitness.provider WHERE user_id = ${ctx.userId}
              )`,
        );
      }

      await tx.execute(sql`DELETE FROM fitness.provider WHERE user_id = ${ctx.userId}`);

      for (const table of USER_SCOPED_DELETE_TABLES) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE user_id = ${ctx.userId}`);
      }
    });

    return { success: true };
  }),
});

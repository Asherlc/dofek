import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const zonePctsSchema = z.array(z.number().min(0).max(3)).min(2).max(10);

const sportSettingsInput = z.object({
  sport: z.string().min(1),
  ftp: z.number().int().positive().optional(),
  thresholdHr: z.number().int().positive().optional(),
  thresholdPacePerKm: z.number().positive().optional(),
  powerZonePcts: zonePctsSchema.optional(),
  hrZonePcts: zonePctsSchema.optional(),
  paceZonePcts: zonePctsSchema.optional(),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  notes: z.string().optional(),
});

const sportSettingsRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  sport: z.string(),
  ftp: z.coerce.number().nullable(),
  threshold_hr: z.coerce.number().nullable(),
  threshold_pace_per_km: z.coerce.number().nullable(),
  power_zone_pcts: z.unknown().nullable(),
  hr_zone_pcts: z.unknown().nullable(),
  pace_zone_pcts: z.unknown().nullable(),
  effective_from: z.string(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const sportSettingsRouter = router({
  /**
   * List all sport settings for the user, grouped by sport.
   * Returns the most recent effective setting per sport.
   */
  list: cachedProtectedQuery(CacheTTL.LONG).query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      sportSettingsRowSchema,
      sql`
      SELECT DISTINCT ON (sport) *
      FROM fitness.sport_settings
      WHERE user_id = ${ctx.userId}
      ORDER BY sport, effective_from DESC
    `,
    );
    return rows;
  }),

  /**
   * Get sport settings for a specific sport, optionally at a specific date.
   * Returns the most recent setting effective on or before the given date.
   */
  getBySport: cachedProtectedQuery(CacheTTL.LONG)
    .input(
      z.object({
        sport: z.string(),
        asOfDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const asOf = input.asOfDate ?? new Date().toISOString().slice(0, 10);
      const rows = await executeWithSchema(
        ctx.db,
        sportSettingsRowSchema,
        sql`
        SELECT *
        FROM fitness.sport_settings
        WHERE user_id = ${ctx.userId}
          AND sport = ${input.sport}
          AND effective_from <= ${asOf}::date
        ORDER BY effective_from DESC
        LIMIT 1
      `,
      );
      return rows[0] ?? null;
    }),

  /**
   * Get full history of sport settings for a specific sport.
   */
  history: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ sport: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        sportSettingsRowSchema,
        sql`
        SELECT *
        FROM fitness.sport_settings
        WHERE user_id = ${ctx.userId}
          AND sport = ${input.sport}
        ORDER BY effective_from DESC
      `,
      );
      return rows;
    }),

  /**
   * Create or update sport settings.
   * If settings already exist for this sport+date, updates them.
   */
  upsert: protectedProcedure.input(sportSettingsInput).mutation(async ({ ctx, input }) => {
    const effectiveFrom = input.effectiveFrom ?? new Date().toISOString().slice(0, 10);

    const rows = await executeWithSchema(
      ctx.db,
      sportSettingsRowSchema,
      sql`
      INSERT INTO fitness.sport_settings (
        user_id, sport, ftp, threshold_hr, threshold_pace_per_km,
        power_zone_pcts, hr_zone_pcts, pace_zone_pcts,
        effective_from, notes
      )
      VALUES (
        ${ctx.userId},
        ${input.sport},
        ${input.ftp ?? null},
        ${input.thresholdHr ?? null},
        ${input.thresholdPacePerKm ?? null},
        ${input.powerZonePcts ? JSON.stringify(input.powerZonePcts) : null}::jsonb,
        ${input.hrZonePcts ? JSON.stringify(input.hrZonePcts) : null}::jsonb,
        ${input.paceZonePcts ? JSON.stringify(input.paceZonePcts) : null}::jsonb,
        ${effectiveFrom}::date,
        ${input.notes ?? null}
      )
      ON CONFLICT (user_id, sport, effective_from)
      DO UPDATE SET
        ftp = EXCLUDED.ftp,
        threshold_hr = EXCLUDED.threshold_hr,
        threshold_pace_per_km = EXCLUDED.threshold_pace_per_km,
        power_zone_pcts = EXCLUDED.power_zone_pcts,
        hr_zone_pcts = EXCLUDED.hr_zone_pcts,
        pace_zone_pcts = EXCLUDED.pace_zone_pcts,
        notes = EXCLUDED.notes,
        updated_at = NOW()
      RETURNING *
    `,
    );
    return rows[0];
  }),

  /**
   * Delete a sport settings entry.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.execute(sql`
        DELETE FROM fitness.sport_settings
        WHERE id = ${input.id}::uuid AND user_id = ${ctx.userId}
      `);
      return { success: true };
    }),
});

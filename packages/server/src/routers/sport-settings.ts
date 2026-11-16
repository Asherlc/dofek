import { invalidateUserQueryDomains } from "dofek/lib/cache";
import { z } from "zod";
import { SportSettingsRepository } from "../repositories/sport-settings-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const zonePctsSchema = z.array(z.number().min(0).max(3)).min(2).max(10);

const sportSettingsInput = z.object({
  sport: z.string().min(1),
  thresholdHr: z.number().int().positive().nullable().optional(),
  thresholdPacePerKm: z.number().positive().nullable().optional(),
  ftp: z.number().int().positive().nullable().optional(),
  powerZonePcts: zonePctsSchema.nullable().optional(),
  hrZonePcts: zonePctsSchema.nullable().optional(),
  paceZonePcts: zonePctsSchema.nullable().optional(),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  notes: z.string().nullable().optional(),
});

export const sportSettingsRouter = router({
  /**
   * List all sport settings for the user, grouped by sport.
   * Returns the most recent effective setting per sport.
   */
  list: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    expiresAt: "localDayBoundary",
    keyVersion: "manual-ftp-v1",
  }).query(async ({ ctx }) => {
    const repository = new SportSettingsRepository(ctx.db, ctx.userId, ctx.timezone);
    return repository.list();
  }),

  /**
   * Get sport settings for a specific sport, optionally at a specific date.
   * Returns the most recent setting effective on or before the given date.
   */
  getBySport: cachedProtectedQuery({
    maxAge: CacheTTL.LONG,
    expiresAt: "localDayBoundary",
    keyVersion: "manual-ftp-v1",
  })
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
      const repository = new SportSettingsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repository.getBySport(input.sport, input.asOfDate);
    }),

  /**
   * Get full history of sport settings for a specific sport.
   */
  history: cachedProtectedQuery({ maxAge: CacheTTL.LONG, keyVersion: "manual-ftp-v1" })
    .input(z.object({ sport: z.string() }))
    .query(async ({ ctx, input }) => {
      const repository = new SportSettingsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repository.history(input.sport);
    }),

  /**
   * Create or update sport settings.
   * If settings already exist for this sport+date, updates them.
   */
  upsert: protectedProcedure.input(sportSettingsInput).mutation(async ({ ctx, input }) => {
    const repository = new SportSettingsRepository(ctx.db, ctx.userId, ctx.timezone);
    const settings = await repository.upsert(input);
    await invalidateUserQueryDomains(ctx.userId, ["sportSettings", "activity", "personalization"]);
    return settings;
  }),

  /**
   * Delete a sport settings entry.
   */
  delete: protectedProcedure.input(z.object({ id: z.guid() })).mutation(async ({ ctx, input }) => {
    const repository = new SportSettingsRepository(ctx.db, ctx.userId, ctx.timezone);
    const result = await repository.delete(input.id);
    await invalidateUserQueryDomains(ctx.userId, ["sportSettings", "activity", "personalization"]);
    return result;
  }),
});

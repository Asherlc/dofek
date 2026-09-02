import { medicationRemindersSchema } from "@dofek/format/medication-reminders";
import { PRIMARY_GOAL_SETTINGS_KEY, primaryGoalIds } from "@dofek/onboarding/primary-goal";
import { invalidateAllUserQueries, queryCache } from "dofek/lib/cache";
import { z } from "zod";
import {
  CLIMBING_GRADE_PREFERENCE_SETTINGS_KEY,
  climbingGradePreferenceSchema,
} from "../climbing-grade-preferences.ts";
import { PROVIDER_ACCOUNT_TABLES } from "../repositories/provider-detail-repository.ts";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const dashboardLayoutSchema = z.strictObject({
  order: z.array(z.string()),
  hidden: z.array(z.string()),
  collapsed: z.record(z.string(), z.boolean()),
});

const settingInputSchema = z.discriminatedUnion("key", [
  z.strictObject({
    key: z.literal("dashboardLayout"),
    value: dashboardLayoutSchema,
  }),
  z.strictObject({
    key: z.literal("unitSystem"),
    value: z.enum(["metric", "imperial"]),
  }),
  z.strictObject({
    key: z.literal("homeTimezone"),
    value: z.string().refine(
      (timezone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
          return true;
        } catch {
          return false;
        }
      },
      { message: "homeTimezone must be a valid IANA timezone" },
    ),
  }),
  z.strictObject({
    key: z.literal(CLIMBING_GRADE_PREFERENCE_SETTINGS_KEY),
    value: climbingGradePreferenceSchema,
  }),
  z.strictObject({
    key: z.literal("whoop.wearLocation"),
    value: z.enum(["wrist", "bicep", "chest", "waist", "calf"]),
  }),
  z.strictObject({
    key: z.literal("medicationReminders"),
    value: medicationRemindersSchema,
  }),
  z.strictObject({
    key: z.literal(PRIMARY_GOAL_SETTINGS_KEY),
    value: z.enum(primaryGoalIds),
  }),
]);

export const settingsRouter = router({
  get: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      const repo = new SettingsRepository(ctx.db, ctx.userId);
      return repo.get(input.key);
    }),

  getAll: cachedProtectedQuery({ maxAge: CacheTTL.LONG }).query(async ({ ctx }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    return repo.getAll();
  }),

  set: protectedProcedure.input(settingInputSchema).mutation(async ({ ctx, input }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    const result = await repo.set(input.key, input.value);

    if (input.key === CLIMBING_GRADE_PREFERENCE_SETTINGS_KEY) {
      await Promise.all([
        queryCache.invalidateByPrefix(`${ctx.userId}:settings.`),
        queryCache.invalidateByPrefix(`${ctx.userId}:climbing.`),
        queryCache.invalidateByPrefix(`${ctx.userId}:mobileDashboard.training`),
      ]);
    } else {
      await queryCache.invalidateByPrefix(`${ctx.userId}:settings.`);
    }

    return result;
  }),

  deleteAllUserData: protectedProcedure.mutation(async ({ ctx }) => {
    const repo = new SettingsRepository(ctx.db, ctx.userId);
    await repo.deleteAllUserData(PROVIDER_ACCOUNT_TABLES);
    await invalidateAllUserQueries(ctx.userId);
    return { success: true };
  }),
});

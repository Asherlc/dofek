import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { loadTodayPlan } from "../services/today-plan.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const supportingFactSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const todayPlanResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    date: z.string(),
    action: z.object({
      id: z.literal("strain_target"),
      title: z.string(),
      summary: z.string(),
      zone: z.enum(["Push", "Maintain", "Recovery"]),
    }),
    supportingFacts: z.tuple([supportingFactSchema, supportingFactSchema]),
    caveats: z.array(z.string()),
    confidence: z.enum(["high", "moderate", "low"]),
    freshness: z.object({
      recoveryDate: z.string().nullable(),
      sleepDate: z.string().nullable(),
    }),
    missingInputs: z.array(z.string()),
  }),
  z.object({
    status: z.literal("insufficient_data"),
    date: z.string(),
    action: z.null(),
    supportingFacts: z.tuple([]),
    confidence: z.literal("low"),
    freshness: z.object({
      recoveryDate: z.string().nullable(),
      sleepDate: z.string().nullable(),
    }),
    missingInputs: z.array(z.string()),
    message: z.string(),
  }),
]);

export const todayPlanRouter = router({
  get: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ days: z.number().default(30), endDate: endDateSchema }))
    .output(todayPlanResultSchema)
    .query(({ ctx, input }) =>
      loadTodayPlan(
        {
          db: ctx.db,
          userId: ctx.userId,
          accessWindow: ctx.accessWindow,
          sensorStore: ctx.sensorStore,
        },
        input.endDate,
        input.days,
      ),
    ),
});

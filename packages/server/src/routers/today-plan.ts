import { z } from "zod";
import { epistemicStatusSchema } from "../contracts/epistemic-status-contract.ts";
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
    epistemicStatus: epistemicStatusSchema,
    date: z.string(),
    action: z.object({
      id: z.literal("strain_target"),
      title: z.string(),
      zone: z.enum(["Push", "Maintain", "Recovery"]),
    }),
    supportingFacts: z.array(supportingFactSchema),
    caveats: z.array(z.string()),
    freshness: z.object({
      recoveryDate: z.string().nullable(),
      sleepDate: z.string().nullable(),
    }),
    missingInputs: z.array(z.string()),
  }),
  z.object({
    status: z.literal("insufficient_data"),
    epistemicStatus: epistemicStatusSchema,
    date: z.string(),
    action: z.null(),
    supportingFacts: z.tuple([]),
    freshness: z.object({
      recoveryDate: z.string().nullable(),
      sleepDate: z.string().nullable(),
    }),
    missingInputs: z.array(z.string()),
    message: z.string(),
  }),
]);

export const todayPlanRouter = router({
  get: cachedProtectedQuery({
    maxAge: CacheTTL.MEDIUM,
    keyVersion: "today-plan-evidence-v2",
  })
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

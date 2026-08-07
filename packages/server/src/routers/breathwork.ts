import {
  BREATHWORK_DIFFICULTIES,
  type BreathworkTechniqueDetails,
  getBreathworkTechniqueLabel,
  PERCEIVED_BREATHWORK_EFFECTS,
  TECHNIQUES,
  toBreathworkTechniqueDetails,
} from "@dofek/scoring/breathwork";
import { invalidateUserQueryDomains } from "dofek/lib/cache";
import { z } from "zod";
import { BreathworkRepository } from "../repositories/breathwork-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const outcomeCountSchema = z.number().int().nonnegative();
const breathworkSafetyOutputSchema = z.object({
  position: z.string(),
  warnings: z.array(z.string()),
  stopCriteria: z.string(),
  emergency: z.string(),
});
const breathworkTechniqueDetailsOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  description: z.string(),
  difficulty: z.enum(BREATHWORK_DIFFICULTIES),
  possibleBenefit: z.string().optional(),
  safety: breathworkSafetyOutputSchema,
  inhaleSeconds: z.number().int().positive(),
  holdInSeconds: z.number().int().positive().optional(),
  exhaleSeconds: z.number().int().positive(),
  holdOutSeconds: z.number().int().positive().optional(),
  defaultRounds: z.number().int().positive(),
  durationSeconds: z.number().int().positive(),
});
const breathworkSessionDetailOutputSchema = z.object({
  id: z.string(),
  techniqueId: z.string(),
  rounds: z.number().int().positive(),
  durationSeconds: z.number().int().positive(),
  startedAt: z.string(),
  notes: z.string().nullable(),
  stressBefore: z.number().int().min(0).max(10).nullable(),
  stressAfter: z.number().int().min(0).max(10).nullable(),
  dizzinessAfter: z.boolean().nullable(),
  perceivedEffect: z.enum(PERCEIVED_BREATHWORK_EFFECTS).nullable(),
});
const outcomeSummaryOutputSchema = z.object({
  windowDays: z.number().int().positive(),
  windowKind: z.literal("rolling-instant"),
  techniques: z.array(
    z.object({
      techniqueId: z.string(),
      sessionCount: outcomeCountSchema,
      stress: z.object({
        reportCount: outcomeCountSchema,
        lowerCount: outcomeCountSchema,
        sameCount: outcomeCountSchema,
        higherCount: outcomeCountSchema,
      }),
      perceivedEffect: z.object({
        reportCount: outcomeCountSchema,
        betterCount: outcomeCountSchema,
        sameCount: outcomeCountSchema,
        worseCount: outcomeCountSchema,
      }),
      dizziness: z.object({
        reportCount: outcomeCountSchema,
        yesCount: outcomeCountSchema,
      }),
    }),
  ),
});

export const breathworkRouter = router({
  techniques: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.void())
    .output(z.array(breathworkTechniqueDetailsOutputSchema))
    .query((): BreathworkTechniqueDetails[] => TECHNIQUES.map(toBreathworkTechniqueDetails)),
  logSession: protectedProcedure
    .input(
      z.object({
        techniqueId: z.string().min(1),
        rounds: z.number().int().min(1),
        durationSeconds: z.number().int().min(1),
        startedAt: z.string(),
        notes: z.string().nullable().default(null),
        stressBefore: z.number().int().min(0).max(10).nullable().default(null),
        stressAfter: z.number().int().min(0).max(10).nullable().default(null),
        dizzinessAfter: z.boolean().nullable().default(null),
        perceivedEffect: z.enum(PERCEIVED_BREATHWORK_EFFECTS).nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const repo = new BreathworkRepository(ctx.db, ctx.userId);
      const session = await repo.logSession(input);
      if (session !== null) {
        await invalidateUserQueryDomains(ctx.userId, ["breathwork"]);
      }
      return session?.toDetail() ?? null;
    }),
  history: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ days: z.number().min(1).max(365).default(30) }))
    .output(z.array(breathworkSessionDetailOutputSchema.extend({ techniqueLabel: z.string() })))
    .query(async ({ ctx, input }) => {
      const repo = new BreathworkRepository(ctx.db, ctx.userId);
      return (await repo.getHistory(input.days)).map((session) => {
        const detail = session.toDetail();
        return {
          ...detail,
          techniqueLabel: getBreathworkTechniqueLabel(detail.techniqueId),
        };
      });
    }),
  outcomes: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.void())
    .output(outcomeSummaryOutputSchema)
    .query(async ({ ctx }) => {
      const repo = new BreathworkRepository(ctx.db, ctx.userId);
      return repo.getOutcomeSummaries();
    }),
});

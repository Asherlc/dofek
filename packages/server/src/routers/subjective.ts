import { TRPCError } from "@trpc/server";
import { invalidateUserQueryDomains } from "dofek/lib/cache";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import {
  injuryKindSchema,
  SubjectiveRepository,
  subjectiveKindSchema,
} from "../repositories/subjective-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const scoreSchema = z.number().int().min(1).max(10);

const symptomInputSchema = z.object({
  bodyRegionId: z.string().min(1),
  kind: subjectiveKindSchema,
  score: scoreSchema,
});

const injuryFieldsSchema = z.object({
  kind: injuryKindSchema,
  bodyRegionId: z.string().min(1),
  onsetDate: dateSchema,
  resolvedDate: dateSchema.nullable(),
  severity: z.number().int().min(0).max(10).nullable(),
  description: z.string().trim().min(1),
});

function assertInjuryDateOrder(onsetDate: string, resolvedDate: string | null): void {
  if (resolvedDate !== null && resolvedDate < onsetDate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "An injury resolution date must not be before its onset date",
    });
  }
}

export const subjectiveRouter = router({
  regions: cachedProtectedQuery({ maxAge: CacheTTL.LONG }).query(async ({ ctx }) => {
    return new SubjectiveRepository(ctx.db, ctx.userId, ctx.timezone).regions();
  }),

  checkIn: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ date: dateSchema }))
    .query(async ({ ctx, input }) => {
      return new SubjectiveRepository(ctx.db, ctx.userId, ctx.timezone).checkIn(input.date);
    }),

  saveCheckIn: protectedProcedure
    .input(z.object({ date: dateSchema, symptoms: z.array(symptomInputSchema).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const result = await new SubjectiveRepository(ctx.db, ctx.userId, ctx.timezone).saveCheckIn(
        input.date,
        input.symptoms,
      );
      await invalidateUserQueryDomains(ctx.userId, ["subjective"]);
      return result;
    }),

  injuries: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).query(async ({ ctx }) => {
    return new SubjectiveRepository(ctx.db, ctx.userId, ctx.timezone).injuries();
  }),

  createInjury: protectedProcedure.input(injuryFieldsSchema).mutation(async ({ ctx, input }) => {
    assertInjuryDateOrder(input.onsetDate, input.resolvedDate);
    const result = await new SubjectiveRepository(ctx.db, ctx.userId, ctx.timezone).createInjury(
      input,
    );
    await invalidateUserQueryDomains(ctx.userId, ["subjective"]);
    return result;
  }),

  updateInjury: protectedProcedure
    .input(
      z.object({
        id: z.guid(),
        kind: injuryKindSchema.optional(),
        bodyRegionId: z.string().min(1).optional(),
        onsetDate: dateSchema.optional(),
        resolvedDate: dateSchema.nullable().optional(),
        severity: z.number().int().min(0).max(10).nullable().optional(),
        description: z.string().trim().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...changes } = input;
      const repository = new SubjectiveRepository(ctx.db, ctx.userId, ctx.timezone);
      const current = await repository.getInjury(id);
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Injury event not found" });
      assertInjuryDateOrder(
        changes.onsetDate ?? current.onset_date,
        changes.resolvedDate !== undefined ? changes.resolvedDate : current.resolved_date,
      );
      const result = await repository.updateInjury(id, changes);
      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Injury event not found" });
      await invalidateUserQueryDomains(ctx.userId, ["subjective"]);
      return result;
    }),

  deleteInjury: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await new SubjectiveRepository(ctx.db, ctx.userId, ctx.timezone).deleteInjury(
        input.id,
      );
      if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "Injury event not found" });
      await invalidateUserQueryDomains(ctx.userId, ["subjective"]);
      return { success: true };
    }),

  timeline: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ startDate: dateSchema, endDate: dateSchema }))
    .query(async ({ ctx, input }) => {
      if (input.startDate > input.endDate) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The subjective timeline start date must not be after its end date",
        });
      }
      return new SubjectiveRepository(ctx.db, ctx.userId, ctx.timezone).timeline(
        input.startDate,
        input.endDate,
      );
    }),
});

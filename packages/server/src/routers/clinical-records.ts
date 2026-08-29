import { TRPCError } from "@trpc/server";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { z } from "zod";
import {
  clinicalRecordDetailSchema,
  clinicalRecordInputSchema,
  clinicalRecordPageSchema,
} from "../clinical-records/fhir.ts";
import { ClinicalRecordsRepository } from "../clinical-records/repository.ts";
import { ensurePushProvider } from "../repositories/push-provider-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const pageSchema = z.object({
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
});

export const clinicalRecordsRouter = router({
  push: protectedProcedure
    .input(z.object({ records: z.array(clinicalRecordInputSchema).max(100) }))
    .output(z.object({ inserted: z.number().int().nonnegative() }))
    .mutation(async ({ ctx, input }) => {
      await ensurePushProvider({
        database: ctx.db,
        providerId: "apple_health",
        providerName: "Apple Health",
        userId: ctx.userId,
      });
      const repository = new ClinicalRecordsRepository(ctx.db, ctx.userId, ctx.timezone);
      const result = await repository.upsert(input.records);
      if (result.inserted > 0) await invalidateAllUserQueries(ctx.userId);
      return { inserted: result.inserted };
    }),

  list: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(pageSchema)
    .output(clinicalRecordPageSchema)
    .query(({ ctx, input }) =>
      new ClinicalRecordsRepository(ctx.db, ctx.userId, ctx.timezone).list(input),
    ),

  detail: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ id: z.uuid() }))
    .output(clinicalRecordDetailSchema)
    .query(async ({ ctx, input }) => {
      const record = await new ClinicalRecordsRepository(ctx.db, ctx.userId, ctx.timezone).detail(
        input.id,
      );
      if (!record) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Clinical record not found." });
      }
      return record;
    }),
});

import { medicationDoseEvent } from "dofek/db/schema";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

const listInputSchema = z.object({
  limit: z.number().int().positive().max(100).default(50),
});

export const medicationDoseEventsRouter = router({
  list: protectedProcedure.input(listInputSchema).query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select({
        id: medicationDoseEvent.id,
        providerId: medicationDoseEvent.providerId,
        medicationName: medicationDoseEvent.medicationName,
        medicationConceptId: medicationDoseEvent.medicationConceptId,
        doseStatus: medicationDoseEvent.doseStatus,
        recordedAt: medicationDoseEvent.recordedAt,
        sourceName: medicationDoseEvent.sourceName,
      })
      .from(medicationDoseEvent)
      .where(eq(medicationDoseEvent.userId, ctx.userId))
      .orderBy(desc(medicationDoseEvent.recordedAt))
      .limit(input.limit);

    return {
      events: rows.map((row) => ({
        ...row,
        recordedAt: row.recordedAt.toISOString(),
      })),
    };
  }),
});

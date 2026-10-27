import { medicationDoseEvent } from "dofek/db/schema/clinical";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { timestampStringSchema } from "../lib/typed-sql.ts";
import { protectedProcedure, router } from "../trpc.ts";

const listInputSchema = z.object({
  limit: z.number().int().positive().max(100).default(50),
});

const listOutputSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      providerId: z.string(),
      medicationName: z.string(),
      medicationConceptId: z.string().nullable(),
      doseStatus: z.string(),
      recordedAt: timestampStringSchema,
      sourceName: z.string().nullable(),
    }),
  ),
});

export const medicationDoseEventsRouter = router({
  list: protectedProcedure
    .input(listInputSchema)
    .output(listOutputSchema)
    .query(async ({ ctx, input }) => {
      const accessWindowPredicate =
        ctx.accessWindow.kind === "limited"
          ? and(
              gte(
                medicationDoseEvent.recordedAt,
                new Date(`${ctx.accessWindow.startDate}T00:00:00.000Z`),
              ),
              lt(
                medicationDoseEvent.recordedAt,
                new Date(`${ctx.accessWindow.endDateExclusive}T00:00:00.000Z`),
              ),
            )
          : undefined;
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
        .where(
          accessWindowPredicate
            ? and(eq(medicationDoseEvent.userId, ctx.userId), accessWindowPredicate)
            : eq(medicationDoseEvent.userId, ctx.userId),
        )
        .orderBy(desc(medicationDoseEvent.recordedAt))
        .limit(input.limit);

      return { events: rows };
    }),
});

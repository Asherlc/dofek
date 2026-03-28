import { z } from "zod";
import {
  DISCONNECT_CHILD_TABLES,
  ProviderDetailRepository,
  dataTypeEnum,
  tableInfo,
} from "../repositories/provider-detail-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

// Re-export for backward compatibility (used by settings router and tests)
export { DISCONNECT_CHILD_TABLES, dataTypeEnum, tableInfo };

const REDACTED_ERROR_MESSAGE = "Details hidden";

function redactLogErrorMessage(errorMessage: string | null): string | null {
  if (!errorMessage) return null;
  return REDACTED_ERROR_MESSAGE;
}

export const providerDetailRouter = router({
  /** Paginated sync logs for a specific provider */
  logs: cachedProtectedQuery(CacheTTL.SHORT)
    .input(
      z.object({
        providerId: z.string(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { syncLog } = await import("dofek/db/schema");
      const { and, desc, eq } = await import("drizzle-orm");

      const rows = await ctx.db
        .select()
        .from(syncLog)
        .where(and(eq(syncLog.userId, ctx.userId), eq(syncLog.providerId, input.providerId)))
        .orderBy(desc(syncLog.syncedAt))
        .limit(input.limit)
        .offset(input.offset);

      return rows.map((row) => ({
        ...row,
        errorMessage: redactLogErrorMessage(row.errorMessage),
      }));
    }),

  /** Paginated records for a provider by data type */
  records: cachedProtectedQuery(CacheTTL.SHORT)
    .input(
      z.object({
        providerId: z.string(),
        dataType: dataTypeEnum,
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new ProviderDetailRepository(ctx.db, ctx.userId);
      const rows = await repo.getRecords(input.providerId, input.dataType, input.limit, input.offset);
      return { rows };
    }),

  /** Single record detail with raw data */
  recordDetail: cachedProtectedQuery(CacheTTL.SHORT)
    .input(
      z.object({
        providerId: z.string(),
        dataType: dataTypeEnum,
        recordId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new ProviderDetailRepository(ctx.db, ctx.userId);
      return repo.getRecordDetail(input.providerId, input.dataType, input.recordId);
    }),

  /** Disconnect a provider — removes all data, OAuth tokens, and provider row */
  disconnect: protectedProcedure
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new ProviderDetailRepository(ctx.db, ctx.userId);

      const isOwner = await repo.verifyOwnership(input.providerId);
      if (!isOwner) {
        throw new Error("Provider not found or not owned by user");
      }

      await repo.deleteProviderData(input.providerId);
      return { success: true };
    }),
});

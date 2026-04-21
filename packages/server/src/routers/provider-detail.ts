import type { SyncDatabase } from "dofek/db";
import * as telemetry from "dofek/telemetry";
import { z } from "zod";
import { logger } from "../logger.ts";
import {
  DISCONNECT_CHILD_TABLES,
  dataTypeEnum,
  ProviderDetailRepository,
  tableInfo,
} from "../repositories/provider-detail-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

// Re-export for backward compatibility (used by settings router and tests)
export { DISCONNECT_CHILD_TABLES, dataTypeEnum, tableInfo };

import { sanitizeErrorMessage } from "../lib/sanitize-error.ts";

/**
 * Attempt to revoke tokens remotely before disconnecting a provider.
 * Best-effort: logs and captures errors but never throws.
 */
async function revokeTokensOnDisconnect(
  db: SyncDatabase,
  userId: string,
  providerId: string,
): Promise<void> {
  try {
    const { loadTokens } = await import("dofek/db/tokens");
    const tokens = await loadTokens(db, providerId, userId);
    if (!tokens) return;

    const { getAllProviders } = await import("dofek/providers/registry");
    const { ensureProvidersRegistered } = await import("./sync.ts");
    await ensureProvidersRegistered();

    const provider = getAllProviders().find(
      (candidate: { id: string }) => candidate.id === providerId,
    );
    if (!provider?.authSetup) return;

    const setup = provider.authSetup();
    if (!setup) return;

    // Provider-specific revocation (e.g., Wahoo's DELETE /v1/permissions
    // which revokes ALL tokens for the app+user, including orphaned ones)
    let customRevocationSucceeded = false;
    if (setup.revokeExistingTokens) {
      try {
        await setup.revokeExistingTokens(tokens);
        logger.info(`[disconnect] Remote token revocation succeeded for ${providerId}`);
        customRevocationSucceeded = true;
      } catch (customError) {
        const message = customError instanceof Error ? customError.message : String(customError);
        logger.warn(
          `[disconnect] Custom revocation failed for ${providerId}, falling back to standard OAuth revocation: ${message}`,
        );
        telemetry.captureException(customError);
      }
    }

    // Standard OAuth revocation via POST /oauth/revoke (RFC 7009).
    // Used as primary when no custom handler, or as fallback when custom fails.
    if (!customRevocationSucceeded && setup.oauthConfig?.revokeUrl) {
      const { revokeToken } = await import("dofek/auth/oauth");
      if (tokens.accessToken) {
        try {
          await revokeToken(setup.oauthConfig, tokens.accessToken);
        } catch (accessError) {
          const message = accessError instanceof Error ? accessError.message : String(accessError);
          logger.warn(`[disconnect] Access token revocation failed for ${providerId}: ${message}`);
          telemetry.captureException(accessError);
        }
      }
      if (tokens.refreshToken) {
        try {
          await revokeToken(setup.oauthConfig, tokens.refreshToken);
        } catch (refreshError) {
          const message =
            refreshError instanceof Error ? refreshError.message : String(refreshError);
          logger.warn(`[disconnect] Refresh token revocation failed for ${providerId}: ${message}`);
          telemetry.captureException(refreshError);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[disconnect] Remote token revocation failed for ${providerId}: ${message}`);
    telemetry.captureException(error);
  }
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
        errorMessage: sanitizeErrorMessage(row.errorMessage),
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
      const rows = await repo.getRecords(
        input.providerId,
        input.dataType,
        input.limit,
        input.offset,
      );
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

  /** Disconnect a provider — revokes remote tokens, then removes all user-scoped data */
  disconnect: protectedProcedure
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new ProviderDetailRepository(ctx.db, ctx.userId);

      const isOwner = await repo.verifyOwnership(input.providerId);
      if (!isOwner) {
        throw new Error("Provider not found or not owned by user");
      }

      // Revoke tokens remotely before deleting local data — prevents orphaned
      // tokens on the provider side (e.g. Wahoo's active token limit).
      await revokeTokensOnDisconnect(ctx.db, ctx.userId, input.providerId);

      await repo.deleteProviderData(input.providerId);
      return { success: true };
    }),
});

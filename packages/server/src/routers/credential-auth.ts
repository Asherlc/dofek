import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { TRPCError } from "@trpc/server";
import { runWithTokenUser } from "dofek/db/token-user-context";
import { ensureProvider, saveTokens } from "dofek/db/tokens";
import { enqueueSyncJob } from "dofek/jobs/enqueue-sync-job";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { reportProviderAuthDiagnostic } from "dofek/lib/provider-diagnostics";
import { authFailureReasonFromError } from "dofek/providers/auth-errors";
import { getAllProviders } from "dofek/providers/registry";
import type { TokenSet } from "dofek/providers/types";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";
import { ensureProvidersRegistered } from "./sync-helpers.ts";

export const credentialAuthRouter = router({
  /** Generic credential sign-in for any provider with automatedLogin */
  signIn: protectedProcedure
    .input(
      z.object({
        providerId: z.string(),
        username: z.string(),
        password: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === input.providerId);
      if (!provider) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Unknown provider: ${input.providerId}`,
        });
      }

      const setup = provider.authSetup?.();
      if (!setup?.automatedLogin) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Provider ${input.providerId} does not support credential authentication`,
        });
      }

      let tokens: TokenSet;
      const automatedLogin = setup.automatedLogin;
      reportProviderAuthDiagnostic(provider.id, "sign_in_started", ctx.userId);
      try {
        tokens = await runWithTokenUser(ctx.userId, () =>
          automatedLogin(input.username, input.password),
        );
      } catch (error) {
        reportProviderAuthDiagnostic(provider.id, "sign_in_failed", ctx.userId);
        if (error instanceof ProviderRateLimitError) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: error.message,
            cause: error,
          });
        }

        if (authFailureReasonFromError(error)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error instanceof Error ? error.message : "Provider authentication failed.",
            cause: error,
          });
        }

        throw error;
      }
      await ensureProvider(ctx.db, provider.id, provider.name, setup.apiBaseUrl, ctx.userId);
      await saveTokens(ctx.db, provider.id, tokens, ctx.userId);
      reportProviderAuthDiagnostic(provider.id, "sign_in_succeeded", ctx.userId);
      await queryCache.invalidateByPrefix(`${ctx.userId}:sync.providers`);

      try {
        await enqueueSyncJob(
          provider.id,
          {
            providerId: provider.id,
            userId: ctx.userId,
            origin: "manual",
            targetRefreshWindow: { type: "full" },
          },
          { singleFlightFullSync: true },
        );
      } catch (error) {
        captureException(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `${provider.name} connected, but its sync could not be started. Try Sync again.`,
          cause: error,
        });
      }

      return { success: true };
    }),
});

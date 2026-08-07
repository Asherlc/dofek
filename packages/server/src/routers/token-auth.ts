import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { TRPCError } from "@trpc/server";
import { connectProviderWithTokens } from "dofek/db/tokens";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { authFailureReasonFromError } from "dofek/providers/auth-errors";
import { getAllProviders } from "dofek/providers/registry";
import type { TokenSet } from "dofek/providers/types";
import { z } from "zod";
import { logger } from "../logger.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { ensureProvidersRegistered } from "./sync-helpers.ts";

export const tokenAuthRouter = router({
  connect: protectedProcedure
    .input(
      z.object({
        providerId: z.string(),
        token: z.string().trim().min(1, "Token is required"),
      }),
    )
    .output(z.object({ success: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((candidate) => candidate.id === input.providerId);
      if (!provider) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Unknown provider: ${input.providerId}`,
        });
      }

      const setup = provider.authSetup?.();
      if (!setup?.manualToken) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Provider ${input.providerId} does not support personal token authentication`,
        });
      }
      if (!setup.apiBaseUrl) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `${provider.name} personal-token authentication is misconfigured.`,
        });
      }

      let tokens: TokenSet;
      try {
        tokens = await setup.manualToken.exchangeToken(input.token);
      } catch (error: unknown) {
        if (error instanceof ProviderServiceUnavailableError) {
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: `${provider.name} is temporarily unavailable. Try again shortly.`,
            cause: error,
          });
        }
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
            message: error instanceof Error ? error.message : "Provider rejected this token.",
            cause: error,
          });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `${provider.name} returned an unexpected response. Try again later.`,
          cause: error,
        });
      }

      try {
        await connectProviderWithTokens(
          ctx.db,
          {
            id: provider.id,
            name: provider.name,
            apiBaseUrl: setup.apiBaseUrl,
          },
          tokens,
          ctx.userId,
        );
      } catch (error: unknown) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Could not save the ${provider.name} connection. Try again later.`,
          cause: error,
        });
      }
      try {
        await queryCache.invalidateByPrefix(`${ctx.userId}:sync.providers`);
      } catch (error: unknown) {
        captureException(error, {
          tags: { procedure: "tokenAuth.connect" },
          extra: { providerId: provider.id, userId: ctx.userId },
        });
        logger.warn(
          `[tokenAuth.connect] Connection persisted but provider cache invalidation failed for ${provider.id} (user ${ctx.userId})`,
        );
      }

      return { success: true };
    }),
});

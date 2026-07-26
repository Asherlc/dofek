import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { TRPCError } from "@trpc/server";
import { ensureProvider, saveTokens } from "dofek/db/tokens";
import { queryCache } from "dofek/lib/cache";
import { authFailureReasonFromError } from "dofek/providers/auth-errors";
import { getAllProviders } from "dofek/providers/registry";
import type { TokenSet } from "dofek/providers/types";
import { z } from "zod";
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

      let tokens: TokenSet;
      try {
        tokens = await setup.manualToken.exchangeToken(input.token);
      } catch (error: unknown) {
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
        throw error;
      }

      await ensureProvider(ctx.db, provider.id, provider.name, setup.apiBaseUrl, ctx.userId);
      await saveTokens(ctx.db, provider.id, tokens, ctx.userId);
      await queryCache.invalidateByPrefix(`${ctx.userId}:sync.providers`);

      return { success: true };
    }),
});

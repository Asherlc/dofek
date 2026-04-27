import { TRPCError } from "@trpc/server";
import { ensureProvider, saveTokens } from "dofek/db/tokens";
import { queryCache } from "dofek/lib/cache";
import { getAllProviders } from "dofek/providers/registry";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";
import { ensureProvidersRegistered } from "./sync.ts";

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

      const tokens = await setup.automatedLogin(input.username, input.password);
      await ensureProvider(ctx.db, provider.id, provider.name, setup.apiBaseUrl, ctx.userId);
      await saveTokens(ctx.db, provider.id, tokens, ctx.userId);
      await queryCache.invalidateByPrefix(`${ctx.userId}:sync.providers`);

      return { success: true };
    }),
});

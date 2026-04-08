import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { queryCache } from "../lib/cache.ts";
import { AuthRepository } from "../repositories/auth-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export const authRouter = router({
  linkedAccounts: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const repo = new AuthRepository(ctx.db, ctx.userId);
    return repo.getLinkedAccounts();
  }),

  unlinkAccount: protectedProcedure
    .input(z.object({ accountId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new AuthRepository(ctx.db, ctx.userId);

      // Ensure user has at least 2 linked accounts before unlinking
      const count = await repo.getAccountCount();
      if (count < 2) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot unlink your only login method",
        });
      }

      // Only delete if it belongs to the current user
      const deletedId = await repo.deleteAccount(input.accountId);
      if (!deletedId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
      }

      await queryCache.invalidateByPrefix(`${ctx.userId}:auth.linkedAccounts`);
      return { ok: true };
    }),
});

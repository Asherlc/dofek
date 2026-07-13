import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { regenerateCompanionToken } from "../companion/token-repository.ts";
import { getCompanionPairingStore } from "../lib/companion-pairing-store.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const companionPairingRouter = router({
  claim: protectedProcedure
    .input(
      z.object({
        code: z.string().trim().min(1),
      }),
    )
    .output(
      z.object({
        state: z.literal("claimed"),
        expiresAt: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const store = getCompanionPairingStore();
      const challenge = await store.getByShortCode(input.code);
      if (!challenge) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pairing code was not found or has expired.",
        });
      }
      if (challenge.claimedAt) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Pairing code has already been used.",
        });
      }

      const companionToken = await regenerateCompanionToken(ctx.db, ctx.userId);
      if (!companionToken.token) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create companion token.",
        });
      }

      const claimedChallenge = await store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: ctx.userId,
        companionToken: companionToken.token,
      });
      if (!claimedChallenge) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Pairing code has already been used.",
        });
      }

      return {
        state: "claimed",
        expiresAt: claimedChallenge.expiresAt,
      };
    }),
});

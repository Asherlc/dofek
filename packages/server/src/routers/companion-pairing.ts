import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { regenerateCompanionToken } from "../companion/token-repository.ts";
import { getCompanionPairingStore, parsePairingCodeInput } from "../lib/companion-pairing-store.ts";
import { protectedProcedure, router } from "../trpc.ts";

const CLAIM_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const CLAIM_ATTEMPT_LIMIT = 20;
const claimAttemptsByUser = new Map<string, { count: number; resetsAt: number }>();

function pruneExpiredClaimAttempts(now: number): void {
  for (const [userId, userAttempts] of claimAttemptsByUser) {
    if (userAttempts.resetsAt <= now) {
      claimAttemptsByUser.delete(userId);
    }
  }
}

function assertClaimAttemptAllowed(userId: string, now = Date.now()): void {
  pruneExpiredClaimAttempts(now);
  const existing = claimAttemptsByUser.get(userId);
  if (!existing || existing.resetsAt <= now) {
    claimAttemptsByUser.set(userId, { count: 1, resetsAt: now + CLAIM_ATTEMPT_WINDOW_MS });
    return;
  }
  if (existing.count >= CLAIM_ATTEMPT_LIMIT) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many pairing attempts. Please wait a few minutes and try again.",
    });
  }
  existing.count += 1;
}

export const companionPairingRouter = router({
  claim: protectedProcedure
    .input(
      z.object({
        code: z.string().transform((code, context) => {
          const parsedCode = parsePairingCodeInput(code);
          if (!parsedCode) {
            context.addIssue({
              code: "custom",
              message: "Enter a valid six-character Zepp pairing code.",
            });
            return z.NEVER;
          }
          return parsedCode;
        }),
      }),
    )
    .output(
      z.object({
        state: z.literal("claimed"),
        expiresAt: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertClaimAttemptAllowed(ctx.userId);
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
          message: "Failed to create Dofek connection.",
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

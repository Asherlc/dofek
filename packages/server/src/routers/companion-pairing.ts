import { captureException } from "dofek/lib/error-reporting";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { DEFAULT_COMPANION_CONNECTION_TYPE } from "../companion/connection-type.ts";
import { regenerateCompanionToken } from "../companion/token-repository.ts";
import { getCompanionPairingStore, parsePairingCodeInput } from "../lib/companion-pairing-store.ts";
import { protectedProcedure, router } from "../trpc.ts";

async function assertClaimAttemptAllowed(
  store: ReturnType<typeof getCompanionPairingStore>,
  userId: string,
): Promise<void> {
  const attemptAllowed = await store.consumeClaimAttempt(userId);
  if (!attemptAllowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many pairing attempts. Please wait a few minutes and try again.",
    });
  }
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
        connectionType: z.enum(["zepp-main", "zepp-workout"]),
        expiresAt: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const store = getCompanionPairingStore();
      await assertClaimAttemptAllowed(store, ctx.userId);
      const challenge = await store.getByShortCode(input.code);
      if (!challenge) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pairing code was not found or has expired.",
        });
      }
      const connectionType = challenge.connectionType ?? DEFAULT_COMPANION_CONNECTION_TYPE;
      if (challenge.claimedAt && challenge.userId !== ctx.userId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Pairing code has already been used.",
        });
      }

      if (challenge.claimedAt && challenge.companionToken) {
        return {
          state: "claimed",
          connectionType,
          expiresAt: challenge.expiresAt,
        };
      }

      const claimedChallenge = await store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: ctx.userId,
      });
      if (!claimedChallenge) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Pairing code has already been used.",
        });
      }

      try {
        const companionToken = await regenerateCompanionToken(ctx.db, ctx.userId, connectionType);
        if (!companionToken.token) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create Dofek connection.",
          });
        }

        const pairedChallenge = await store.setClaimedChallengeToken({
          shortCode: challenge.shortCode,
          userId: ctx.userId,
          companionToken: companionToken.token,
        });
        if (!pairedChallenge) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Pairing code has already been used.",
          });
        }

        return {
          state: "claimed",
          connectionType: pairedChallenge.connectionType ?? DEFAULT_COMPANION_CONNECTION_TYPE,
          expiresAt: pairedChallenge.expiresAt,
        };
      } catch (error) {
        try {
          await store.releaseClaimedChallengeTokenIssuance({
            shortCode: challenge.shortCode,
            userId: ctx.userId,
          });
        } catch (releaseError) {
          captureException(releaseError);
        }
        throw error;
      }
    }),
});

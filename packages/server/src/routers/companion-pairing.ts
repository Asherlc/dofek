import { TRPCError } from "@trpc/server";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { DEFAULT_COMPANION_CONNECTION_TYPE } from "../companion/connection-type.ts";
import { regenerateCompanionTokenInTransaction } from "../companion/token-repository.ts";
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
      let claimedByRequest = false;
      let pairedToken: string | null = null;
      try {
        return await withAccountErasureUserWriteFence(ctx.db, ctx.userId, async (transaction) => {
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
          claimedByRequest = true;

          const companionToken = await regenerateCompanionTokenInTransaction(
            transaction,
            ctx.userId,
            connectionType,
          );
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
          pairedToken = companionToken.token;

          return {
            state: "claimed" as const,
            connectionType: pairedChallenge.connectionType ?? DEFAULT_COMPANION_CONNECTION_TYPE,
            expiresAt: pairedChallenge.expiresAt,
          };
        });
      } catch (error: unknown) {
        if (pairedToken) {
          try {
            await store.deleteClaimedChallenge({
              shortCode: input.code,
              userId: ctx.userId,
              companionToken: pairedToken,
            });
          } catch (deleteError: unknown) {
            captureException(deleteError);
          }
        } else if (claimedByRequest) {
          try {
            await store.releaseClaimedChallengeTokenIssuance({
              shortCode: input.code,
              userId: ctx.userId,
            });
          } catch (releaseError: unknown) {
            captureException(releaseError);
          }
        }
        throw error;
      }
    }),
});

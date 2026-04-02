import { ensureProvider, saveTokens } from "dofek/db/tokens";
import { WhoopClient } from "whoop-whoop";
import { z } from "zod";
import { queryCache } from "../lib/cache.ts";
import {
  DEFAULT_CHALLENGE_TTL_MS,
  getWhoopVerificationChallengeStore,
} from "../lib/whoop-verification-challenge-store.ts";
import { protectedProcedure, router } from "../trpc.ts";

const challengeStore = getWhoopVerificationChallengeStore();

export const whoopAuthRouter = router({
  /** Step 1: Sign in with email + password via Cognito */
  signIn: protectedProcedure
    .input(z.object({ username: z.string(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await WhoopClient.signIn(input.username, input.password);

      if (result.type === "verification_required") {
        // Store Cognito session for step 2 in Redis so all API replicas can read it.
        const challengeId = `whoop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await challengeStore.save(challengeId, {
          session: result.session,
          method: result.method,
          username: input.username,
          expiresAt: Date.now() + DEFAULT_CHALLENGE_TTL_MS,
          userId: ctx.userId,
        });

        return {
          status: "verification_required" as const,
          challengeId,
          method: result.method,
        };
      }

      // No MFA — save tokens directly
      const { token } = result;
      return {
        status: "success" as const,
        token: {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          userId: token.userId,
        },
      };
    }),

  /** Step 2: Submit MFA verification code via Cognito RespondToAuthChallenge */
  verifyCode: protectedProcedure
    .input(z.object({ challengeId: z.string(), code: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const challenge = await challengeStore.get(input.challengeId);
      if (!challenge) {
        throw new Error("Verification session expired or not found");
      }

      if (challenge.userId !== ctx.userId) {
        throw new Error("Verification session not owned by current user");
      }

      if (challenge.expiresAt < Date.now()) {
        await challengeStore.delete(input.challengeId);
        throw new Error("Verification session expired — please sign in again");
      }

      const token = await WhoopClient.verifyCode(challenge.session, input.code, challenge.username);
      await challengeStore.delete(input.challengeId);

      return {
        status: "success" as const,
        token: {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          userId: token.userId,
        },
      };
    }),

  /** Save tokens after successful auth (called by UI after signIn or verifyCode) */
  saveTokens: protectedProcedure
    .input(
      z.object({
        accessToken: z.string(),
        refreshToken: z.string(),
        userId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db, "whoop", "WHOOP", undefined, ctx.userId);
      await saveTokens(ctx.db, "whoop", {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        scopes: `userId:${input.userId}`,
      });
      await queryCache.invalidateByPrefix(`${ctx.userId}:sync.providers`);
      return { success: true };
    }),
});

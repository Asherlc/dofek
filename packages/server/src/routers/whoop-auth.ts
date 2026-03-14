import { ensureProvider, saveTokens } from "dofek/db/tokens";
import { WhoopClient } from "whoop-whoop";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

// In-memory store for pending MFA challenges (keyed by a random ID)
const pendingChallenges = new Map<
  string,
  { session: string; method: string; username: string; expiresAt: number }
>();

function cleanupExpired() {
  const now = Date.now();
  for (const [key, val] of pendingChallenges) {
    if (val.expiresAt < now) pendingChallenges.delete(key);
  }
}

export const whoopAuthRouter = router({
  /** Step 1: Sign in with email + password via Cognito */
  signIn: protectedProcedure
    .input(z.object({ username: z.string(), password: z.string() }))
    .mutation(async ({ input }) => {
      const result = await WhoopClient.signIn(input.username, input.password);

      if (result.type === "verification_required") {
        // Store Cognito session for step 2
        const challengeId = `whoop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        pendingChallenges.set(challengeId, {
          session: result.session,
          method: result.method,
          username: input.username,
          expiresAt: Date.now() + 10 * 60 * 1000, // 10 min TTL
        });
        cleanupExpired();

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
    .mutation(async ({ input }) => {
      const challenge = pendingChallenges.get(input.challengeId);
      if (!challenge) {
        throw new Error("Verification session expired or not found");
      }
      if (challenge.expiresAt < Date.now()) {
        pendingChallenges.delete(input.challengeId);
        throw new Error("Verification session expired — please sign in again");
      }

      const token = await WhoopClient.verifyCode(challenge.session, input.code, challenge.username);
      pendingChallenges.delete(input.challengeId);

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
      await ensureProvider(ctx.db, "whoop", "WHOOP");
      await saveTokens(ctx.db, "whoop", {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        scopes: `userId:${input.userId}`,
      });
      return { success: true };
    }),
});

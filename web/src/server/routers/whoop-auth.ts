import { ensureProvider, saveTokens } from "dofek/db/tokens";
import { WhoopInternalClient } from "dofek/providers/whoop";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.ts";

// In-memory store for pending 2FA challenges (keyed by a random ID)
const pendingChallenges = new Map<
  string,
  { state: string; method: string; username: string; expiresAt: number }
>();

function cleanupExpired() {
  const now = Date.now();
  for (const [key, val] of pendingChallenges) {
    if (val.expiresAt < now) pendingChallenges.delete(key);
  }
}

export const whoopAuthRouter = router({
  /** Step 1: Sign in with email + password */
  signIn: publicProcedure
    .input(z.object({ username: z.string(), password: z.string() }))
    .mutation(async ({ input }) => {
      const result = await WhoopInternalClient.signIn(input.username, input.password);

      if (result.type === "verification_required") {
        // Store challenge state for step 2
        const challengeId = `whoop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        pendingChallenges.set(challengeId, {
          state: result.state,
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

      // No 2FA — save tokens directly
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

  /** Step 2: Submit 2FA verification code */
  verifyCode: publicProcedure
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

      const token = await WhoopInternalClient.verifyCode(challenge.state, input.code);
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
  saveTokens: publicProcedure
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

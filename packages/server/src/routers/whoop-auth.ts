import * as Sentry from "@sentry/node";
import { TRPCError } from "@trpc/server";
import { ensureProvider, saveTokens } from "dofek/db/tokens";
import { queryCache } from "dofek/lib/cache";
import { WhoopClient } from "whoop-whoop/client";
import { z } from "zod";
import {
  DEFAULT_CHALLENGE_TTL_MS,
  getWhoopVerificationChallengeStore,
} from "../lib/whoop-verification-challenge-store.ts";
import { logger } from "../logger.ts";
import { protectedProcedure, router } from "../trpc.ts";

const challengeStore = getWhoopVerificationChallengeStore();

export const whoopAuthRouter = router({
  /** Step 1: Sign in with email + password via Cognito */
  signIn: protectedProcedure
    .input(z.object({ username: z.string(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      logger.info(
        `[whoopAuth] signIn start userId=${ctx.userId} usernameDomain=${input.username.split("@")[1] ?? "unknown"}`,
      );
      try {
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

          logger.info(
            `[whoopAuth] signIn verification_required userId=${ctx.userId} method=${result.method} challengeId=${challengeId}`,
          );

          return {
            status: "verification_required" as const,
            challengeId,
            method: result.method,
          };
        }

        // No MFA — save tokens directly
        const { token } = result;
        logger.info(`[whoopAuth] signIn success userId=${ctx.userId} whoopUserId=${token.userId}`);
        return {
          status: "success" as const,
          token: {
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            userId: token.userId,
          },
        };
      } catch (error) {
        logger.error(
          `[whoopAuth] signIn failed userId=${ctx.userId} message=${error instanceof Error ? error.message : String(error)}`,
        );
        Sentry.captureException(error);
        throw error;
      }
    }),

  /** Step 2: Submit MFA verification code via Cognito RespondToAuthChallenge */
  verifyCode: protectedProcedure
    .input(z.object({ challengeId: z.string(), code: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const challenge = await challengeStore.get(input.challengeId);
      logger.info(
        `[whoopAuth] verifyCode lookup userId=${ctx.userId} challengeId=${input.challengeId} found=${challenge ? "true" : "false"}`,
      );
      if (!challenge) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Verification session expired or not found — please sign in again",
        });
      }

      if (challenge.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Verification session not owned by current user",
        });
      }

      if (challenge.expiresAt < Date.now()) {
        await challengeStore.delete(input.challengeId);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Verification session expired — please sign in again",
        });
      }

      logger.info(
        `[whoopAuth] verifyCode start userId=${ctx.userId} challengeId=${input.challengeId} method=${challenge.method}`,
      );
      try {
        const token = await WhoopClient.verifyCode(
          challenge.session,
          input.code,
          challenge.username,
          challenge.method === "totp" ? "totp" : "sms",
        );
        await challengeStore.delete(input.challengeId);
        logger.info(
          `[whoopAuth] verifyCode success userId=${ctx.userId} challengeId=${input.challengeId} method=${challenge.method} whoopUserId=${token.userId}`,
        );

        return {
          status: "success" as const,
          token: {
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            userId: token.userId,
          },
        };
      } catch (error) {
        logger.error(
          `[whoopAuth] verifyCode failed userId=${ctx.userId} challengeId=${input.challengeId} method=${challenge.method} message=${error instanceof Error ? error.message : String(error)}`,
        );
        Sentry.captureException(error);
        throw error;
      }
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
      await saveTokens(
        ctx.db,
        "whoop",
        {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          scopes: `userId:${input.userId}`,
        },
        ctx.userId,
      );
      await queryCache.invalidateByPrefix(`${ctx.userId}:sync.providers`);
      return { success: true };
    }),
});

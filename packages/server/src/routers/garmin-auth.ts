import { ensureProvider, saveTokens } from "dofek/db/tokens";
import { queryCache } from "dofek/lib/cache";
import { GarminConnectClient } from "garmin-connect/client";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

export const garminAuthRouter = router({
  /** Sign in with Garmin Connect credentials and save tokens in one step */
  signIn: protectedProcedure
    .input(z.object({ username: z.string(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { tokens } = await GarminConnectClient.signIn(
        input.username,
        input.password,
        "garmin.com",
      );

      await ensureProvider(ctx.db, "garmin", "Garmin Connect", undefined, ctx.userId);
      await saveTokens(
        ctx.db,
        "garmin",
        {
          accessToken: JSON.stringify(tokens),
          refreshToken: null,
          expiresAt: new Date(Date.now() + tokens.oauth2.expires_in * 1000),
          scopes: "garmin-connect-internal",
        },
        ctx.userId,
      );
      await queryCache.invalidateByPrefix(`${ctx.userId}:sync.providers`);

      return { success: true };
    }),
});

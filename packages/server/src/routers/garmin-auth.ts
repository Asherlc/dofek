import { GarminConnectClient } from "@dofek/garmin-connect/client";
import { saveTokens } from "dofek/db/tokens";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

import { completeCredentialReconnect } from "./credential-reconnect.ts";

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

      await completeCredentialReconnect(
        ctx,
        { id: "garmin", name: "Garmin Connect" },
        (transaction) =>
          saveTokens(
            transaction,
            "garmin",
            {
              accessToken: JSON.stringify(tokens),
              refreshToken: null,
              expiresAt: new Date(Date.now() + tokens.oauth2.expires_in * 1000),
              scopes: "garmin-connect-internal",
            },
            ctx.userId,
          ),
      );

      return { success: true };
    }),
});

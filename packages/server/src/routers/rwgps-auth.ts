import { ensureProvider, saveTokens } from "dofek/db/tokens";
import { RideWithGpsClient } from "dofek/providers/ride-with-gps";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

export const rwgpsAuthRouter = router({
  /** Exchange RWGPS credentials for an auth token and store it */
  signIn: protectedProcedure
    .input(
      z.object({
        apiKey: z.string().min(1, "API key is required"),
        email: z.string().email("Valid email is required"),
        password: z.string().min(1, "Password is required"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Exchange credentials for auth token via RWGPS API
      const authToken = await RideWithGpsClient.exchangeCredentials(
        input.apiKey,
        input.email,
        input.password,
      );

      // Store API key in scopes field, auth token as accessToken
      await ensureProvider(ctx.db, "ride-with-gps", "RideWithGPS", "https://ridewithgps.com");
      await saveTokens(ctx.db, "ride-with-gps", {
        accessToken: authToken,
        refreshToken: input.apiKey,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // RWGPS tokens don't expire
        scopes: `email:${input.email}`,
      });

      return { success: true };
    }),
});

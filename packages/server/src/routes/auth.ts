import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import type { Database } from "dofek/db";
import { createAuthHandlers } from "./auth/handlers.ts";

// Rate limiter for auth endpoints (login, callback, native sign-in)
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30, // 30 attempts per window per IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Too many authentication attempts — please try again later",
});

export function createAuthRouter(db: Database): Router {
  const router = Router();
  const handlers = createAuthHandlers(db);

  router.get("/api/auth/providers", handlers.listProviders);
  router.get("/auth/login/:provider", handlers.startIdentityLogin);
  router.get("/auth/link/:provider", handlers.startIdentityLink);

  router.get("/auth/callback/:provider", authRateLimiter, handlers.handleIdentityCallback);
  // Apple Sign In uses response_mode=form_post, sending code/state as POST body
  router.post(
    "/auth/callback/:provider",
    authRateLimiter,
    express.urlencoded({ extended: false }),
    handlers.handleIdentityCallback,
  );

  // Native Apple Sign In (iOS)
  router.post(
    "/auth/apple/native",
    authRateLimiter,
    express.urlencoded({ extended: false }),
    express.json(),
    handlers.handleNativeAppleSignIn,
  );

  router.post("/auth/logout", handlers.logout);
  router.get("/api/auth/me", handlers.getCurrentUser);

  // Slack OAuth
  router.get("/auth/provider/slack", authRateLimiter, handlers.startSlackAuth);

  // Data provider login/link
  router.get("/auth/login/data/:provider", authRateLimiter, handlers.startDataProviderLogin);
  router.get("/auth/link/data/:provider", authRateLimiter, handlers.startDataProviderLink);
  router.get("/auth/provider/:provider", authRateLimiter, handlers.startDataProviderOAuthRoute);

  // Shared OAuth callback (OAuth 1.0 and 2.0)
  router.get("/callback", authRateLimiter, handlers.handleOAuthCallback);

  // Complete signup (for providers that don't provide email)
  router.post(
    "/auth/complete-signup",
    express.urlencoded({ extended: false }),
    handlers.completeSignup,
  );

  return router;
}

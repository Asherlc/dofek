import express, { Router } from "express";
import { handleAppleNativeSignIn } from "./apple-native.ts";
import { handleCompleteSignup } from "./complete-signup.ts";
import { handleOAuth2Callback } from "./data-provider-callback.ts";
import {
  handleDataLinkStart,
  handleDataLoginStart,
  handleDataProviderOAuthStart,
} from "./data-provider-oauth.ts";
import { handleIdentityCallback } from "./identity-callback.ts";
import { handleIdentityLink } from "./identity-link.ts";
import { handleIdentityLogin } from "./identity-login.ts";
import { handleGetAuthProviders } from "./providers-list.ts";
import { handleGetMe, handleLogout } from "./session.ts";
import { authRateLimiter, initAuthStores } from "./shared.ts";
import { handleSlackOAuthStart } from "./slack-oauth.ts";

export function createAuthRouter(database: import("dofek/db").Database): Router {
  initAuthStores(database);
  const router = Router();

  // Route registration order matters for Express — preserve the same order as the original file.

  // Providers list
  router.get("/api/auth/providers", handleGetAuthProviders);

  // Identity login
  router.get("/auth/login/:provider", authRateLimiter, handleIdentityLogin);

  // Identity link (add identity provider to existing account)
  router.get("/auth/link/:provider", authRateLimiter, handleIdentityLink);

  // Identity callback (GET for most providers, POST for Apple form_post)
  router.get("/auth/callback/:provider", authRateLimiter, handleIdentityCallback);
  router.post(
    "/auth/callback/:provider",
    authRateLimiter,
    express.urlencoded({ extended: false }),
    handleIdentityCallback,
  );

  // Native Apple Sign In (iOS)
  router.post(
    "/auth/apple/native",
    authRateLimiter,
    express.urlencoded({ extended: false }),
    express.json(),
    handleAppleNativeSignIn,
  );

  // Session management
  router.post("/auth/logout", handleLogout);
  router.get("/api/auth/me", handleGetMe);

  // Slack must be registered before the generic :provider route
  router.get("/auth/provider/slack", authRateLimiter, handleSlackOAuthStart);

  // Data provider OAuth routes (login, link, data sync)
  router.get("/auth/login/data/:provider", authRateLimiter, handleDataLoginStart);
  router.get("/auth/link/data/:provider", authRateLimiter, handleDataLinkStart);
  router.get("/auth/provider/:provider", authRateLimiter, handleDataProviderOAuthStart);

  // OAuth2 callback (shared for all data providers + Slack)
  router.get("/callback", authRateLimiter, handleOAuth2Callback);

  // Complete signup (email collection for providers that don't provide email)
  router.post(
    "/auth/complete-signup",
    express.urlencoded({ extended: false }),
    handleCompleteSignup,
  );

  return router;
}

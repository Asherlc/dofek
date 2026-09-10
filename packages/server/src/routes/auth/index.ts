import express, { Router } from "express";
import { handleAppleNativeSignIn } from "./apple-native.ts";
import { handleCompleteSignup } from "./complete-signup.ts";
import { handleOAuth2Callback } from "./data-provider-callback.ts";
import {
  handleDataLinkStart,
  handleDataLoginStart,
  handleDataProviderOAuthStart,
  handleMobileProviderHandoff,
} from "./data-provider-oauth.ts";
import { handleIdentityCallback } from "./identity-callback.ts";
import { handleIdentityLink } from "./identity-link.ts";
import { handleIdentityLogin } from "./identity-login.ts";
import { handleMobileAuthExchange } from "./mobile-auth-exchange.ts";
import {
  handlePasswordLogin,
  handlePasswordRegister,
  handlePasswordResetConfirm,
  handlePasswordResetRequest,
} from "./password-auth.ts";
import { handleGetAuthProviders } from "./providers-list.ts";
import { handleGetMe, handleLogout } from "./session.ts";
import { authRateLimiter, initAuthStores } from "./shared.ts";

export function createAuthRouter(database: import("dofek/db").Database): Router {
  initAuthStores(database);
  const router = Router();

  // Route registration order matters for Express — preserve the same order as the original file.

  // Providers list
  router.get("/api/auth/providers", authRateLimiter, handleGetAuthProviders);

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

  // Email/password authentication
  router.post("/auth/register", authRateLimiter, express.json(), handlePasswordRegister);
  router.post("/auth/login/password", authRateLimiter, express.json(), handlePasswordLogin);
  router.post("/auth/mobile/exchange", authRateLimiter, express.json(), handleMobileAuthExchange);
  router.post(
    "/auth/password-reset/request",
    authRateLimiter,
    express.json(),
    handlePasswordResetRequest,
  );
  router.post(
    "/auth/password-reset/confirm",
    authRateLimiter,
    express.json(),
    handlePasswordResetConfirm,
  );

  // Session management
  router.post("/auth/logout", handleLogout);
  router.get("/api/auth/me", handleGetMe);

  // Data provider OAuth routes (login, link, data sync)
  router.get("/auth/login/data/:provider", authRateLimiter, handleDataLoginStart);
  router.get("/auth/link/data/:provider", authRateLimiter, handleDataLinkStart);
  router.post(
    "/auth/provider/:provider/hand-off",
    authRateLimiter,
    express.json(),
    handleMobileProviderHandoff,
  );
  router.get("/auth/provider/:provider", authRateLimiter, handleDataProviderOAuthStart);

  // OAuth2 callback shared for all data providers
  router.get("/callback", authRateLimiter, handleOAuth2Callback);

  // Complete signup (email collection for providers that don't provide email)
  router.post(
    "/auth/complete-signup",
    authRateLimiter,
    express.urlencoded({ extended: false }),
    handleCompleteSignup,
  );

  return router;
}

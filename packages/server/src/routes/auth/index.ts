import { Router } from "express";
import { registerAppleNativeRoutes } from "./apple-native.ts";
import { registerCompleteSignupRoutes } from "./complete-signup.ts";
import { registerDataProviderCallbackRoutes } from "./data-provider-callback.ts";
import { registerDataProviderOAuthRoutes } from "./data-provider-oauth.ts";
import { registerIdentityCallbackRoutes } from "./identity-callback.ts";
import { registerIdentityLinkRoutes } from "./identity-link.ts";
import { registerIdentityLoginRoutes } from "./identity-login.ts";
import { registerProvidersListRoutes } from "./providers-list.ts";
import { registerSessionRoutes } from "./session.ts";
import { initAuthStores } from "./shared.ts";
import { registerSlackOAuthRoutes } from "./slack-oauth.ts";

export { oauthSuccessHtml } from "./shared.ts";

export function createAuthRouter(database: import("dofek/db").Database): Router {
  initAuthStores(database);
  const router = Router();

  // Route registration order matters for Express — preserve the same order as the original file.
  registerProvidersListRoutes(router);
  registerIdentityLoginRoutes(router);
  registerIdentityLinkRoutes(router);
  registerIdentityCallbackRoutes(router);
  registerAppleNativeRoutes(router);
  registerSessionRoutes(router);
  // Slack must be registered before the generic :provider route
  registerSlackOAuthRoutes(router);
  registerDataProviderOAuthRoutes(router);
  registerDataProviderCallbackRoutes(router);
  registerCompleteSignupRoutes(router);

  return router;
}

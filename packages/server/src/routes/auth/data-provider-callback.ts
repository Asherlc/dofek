import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import type { OAuthConfig, TokenSet } from "dofek/auth/oauth";
import type { Database, SyncDatabase, TransactionDatabase } from "dofek/db";
import {
  AccountErasureIdentityFencedError,
  AccountErasureUserFencedError,
  lockAndAssertAccountErasureIdentityWriteFence,
  withAccountErasureUserAndIdentityWriteFence,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import type { Request, Response } from "express";
import {
  findExistingUserId,
  MissingEmailForSignupError,
  resolveOrCreateUser,
} from "../../auth/account-linking.ts";
import {
  getSessionIdFromRequest,
  isValidMobileScheme,
  setSessionCookie,
} from "../../auth/cookies.ts";
import { revokeProviderCredentials } from "../../auth/provider-credential-revocation.ts";
import { createSession, validateSession } from "../../auth/session.ts";
import { logger } from "../../logger.ts";
import {
  completeSignupHtml,
  getDb,
  getMobileAuthExchangeStoreRef,
  getOAuth1SecretStoreRef,
  getOAuthStateStoreRef,
  getPendingEmailSignupStoreRef,
  getPostLoginRedirect,
  oauthSuccessHtml,
  persistProviderConnection,
} from "./shared.ts";

interface ReconnectFailure {
  kind: "preserved" | "removed";
  providerName: string;
}

type DeferredOAuthResponse =
  | { kind: "redirect"; location: string }
  | { body: string; kind: "send"; statusCode?: number };

type DeferredOAuthCompletion =
  | { kind: "failure"; error: unknown }
  | { kind: "response"; response: DeferredOAuthResponse };

type ProviderAuthorizationOperationDatabase = SyncDatabase & Pick<Database, "transaction">;

const WAHOO_TOKEN_LIMIT_ERROR = "Too many unrevoked access tokens";

function isWahooTokenLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(WAHOO_TOKEN_LIMIT_ERROR);
}

async function removeRevokedAuthorization(
  db: ProviderAuthorizationOperationDatabase,
  providerId: string,
  userId: string,
): Promise<void> {
  const { deleteProviderAuthorization } = await import("dofek/db/tokens");
  try {
    await deleteProviderAuthorization(db, providerId, userId);
  } catch (deleteError: unknown) {
    const detail = deleteError instanceof Error ? deleteError.message : String(deleteError);
    const cleanupError = new Error(
      `${providerId} authorization was revoked but its stored credential could not be deleted; a stale revoked credential remains stored: ${detail}`,
      { cause: deleteError },
    );
    logger.error(`[auth] ${cleanupError.message}`, {
      err: deleteError,
      providerId,
      userId,
    });
    throw cleanupError;
  }
  await queryCache.invalidateByPrefix(`${userId}:sync.providers`);
}

async function revokeSupersededAuthorization(params: {
  oauthConfig: OAuthConfig;
  tokens: TokenSet;
  providerId: string;
  revokeExistingTokens?: (tokens: TokenSet) => Promise<void>;
}): Promise<void> {
  await revokeProviderCredentials(params);
}

function sendDeferredOAuthResponse(res: Response, response: DeferredOAuthResponse): void {
  if (response.kind === "redirect") {
    res.redirect(response.location);
    return;
  }
  if (response.statusCode !== undefined) {
    res.status(response.statusCode);
  }
  res.send(response.body);
}

export async function handleOAuth2Callback(req: Request, res: Response): Promise<void> {
  let resolvedProviderName: string | undefined;
  let reconnectFailure: ReconnectFailure | undefined;
  let revokedAuthorizationNeedsDurableRemoval = false;
  try {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const error = typeof req.query.error === "string" ? req.query.error : undefined;
    const oauthToken =
      typeof req.query.oauth_token === "string" ? req.query.oauth_token : undefined;
    const oauthVerifier =
      typeof req.query.oauth_verifier === "string" ? req.query.oauth_verifier : undefined;

    // Bare GET with no params — providers (e.g. Withings) verify the URL is reachable
    if (!code && !state && !error && !oauthToken) {
      res.send("OK");
      return;
    }

    if (error) {
      res.status(400).type("text/plain").send("Authorization denied");
      return;
    }

    const db = getDb();
    const oauth1SecretStore = getOAuth1SecretStoreRef();
    const oauthStateStore = getOAuthStateStoreRef();

    // ── OAuth 1.0 callback (FatSecret) ──
    if (oauthToken && oauthVerifier) {
      const stored = await oauth1SecretStore.get(oauthToken);
      if (!stored) {
        res.status(400).send("Unknown or expired OAuth 1.0 request token");
        return;
      }
      await oauth1SecretStore.delete(oauthToken);

      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("../../routers/sync-helpers.ts");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === stored.providerId);
      if (!provider) {
        res.status(404).send("Unknown provider");
        return;
      }

      const setup = provider.authSetup?.({ host: req.get("host") });
      if (!setup?.oauth1Flow) {
        res.status(400).send("Provider does not support OAuth 1.0");
        return;
      }
      const oauth1Flow = setup.oauth1Flow;

      await withAccountErasureUserWriteFence(db, stored.userId, async (transaction) => {
        logger.info(`[auth] Exchanging OAuth 1.0 tokens for ${stored.providerId}...`);
        const { token, tokenSecret } = await oauth1Flow.exchangeForAccessToken(
          oauthToken,
          stored.tokenSecret,
          oauthVerifier,
        );

        const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
        await ensureProvider(transaction, provider.id, provider.name, undefined, stored.userId);
        // Store OAuth 1.0 tokens — token as accessToken, tokenSecret as refreshToken.
        // OAuth 1.0 tokens don't expire.
        await saveTokens(
          transaction,
          provider.id,
          {
            accessToken: token,
            refreshToken: tokenSecret,
            expiresAt: new Date("2099-12-31"),
            scopes: "",
          },
          stored.userId,
        );
        await queryCache.invalidateByPrefix(`${stored.userId}:sync.providers`);
      });

      logger.info(`[auth] ${stored.providerId} OAuth 1.0 tokens saved.`);
      res.send(oauthSuccessHtml(provider.name, undefined, provider.id));
      return;
    }

    // ── OAuth 2.0 callback ──
    if (!code || !state) {
      res.status(400).send("Missing code or state parameter");
      return;
    }

    // Resolve provider from random state token
    const stateEntry = await oauthStateStore.get(state);
    if (!stateEntry) {
      const errorDetail = req.get("host")?.includes("localhost")
        ? " (Are you using an IP or host that differs from what the provider redirected to? Try setting OAUTH_REDIRECT_URI in your .env if testing on mobile.)"
        : "";
      res.status(400).send(`Unknown or expired OAuth state${errorDetail}`);
      return;
    }
    await oauthStateStore.delete(state);

    const {
      providerId,
      codeVerifier: storedCodeVerifier,
      intent,
      linkUserId,
      userId: stateUserId,
      returnTo,
    } = stateEntry;
    // Use providerId immediately so errors before provider lookup still carry context.
    resolvedProviderName = providerId;

    const { getAllProviders } = await import("dofek/providers/registry");
    const { ensureProvidersRegistered } = await import("../../routers/sync-helpers.ts");
    await ensureProvidersRegistered();

    const provider = getAllProviders().find((p) => p.id === providerId);
    if (!provider) {
      res.status(404).send("Unknown provider");
      return;
    }
    resolvedProviderName = provider.name;

    const setup = provider.authSetup?.({ host: req.get("host") });
    if (!setup?.oauthConfig || !setup.exchangeCode) {
      res.status(400).send("Provider does not support OAuth code exchange");
      return;
    }
    const oauthConfig = setup.oauthConfig;
    const exchangeCode = setup.exchangeCode;

    if (setup.getUserIdentity && intent === "data") {
      const sessionId = getSessionIdFromRequest(req);
      const session = sessionId ? await validateSession(db, sessionId) : null;
      if (session && session.userId !== stateUserId) {
        throw new Error("OAuth callback session does not match authenticated OAuth state");
      }
    }

    let issuedTokens: TokenSet | null = null;
    const completeOAuthConnection = async (
      operationDb: ProviderAuthorizationOperationDatabase,
      identityLockTransaction?: TransactionDatabase,
    ): Promise<DeferredOAuthCompletion> => {
      let existingTokens: TokenSet | null = null;
      const isDataReconnect = intent === "data";
      if (isDataReconnect && (setup.revokeExistingTokens || oauthConfig.revokeUrl)) {
        const { loadTokens } = await import("dofek/db/tokens");
        existingTokens = await loadTokens(operationDb, providerId, stateUserId);
      }

      if (existingTokens && setup.reconnectStrategy === "revoke-then-replace") {
        if (!setup.revokeExistingTokens) {
          throw new Error(
            `${provider.name} requires pre-exchange revocation but has no revocation handler`,
          );
        }
        reconnectFailure = { kind: "preserved", providerName: provider.name };
        logger.info(`[auth] Revoking existing ${providerId} authorization before exchange...`);
        await setup.revokeExistingTokens(existingTokens);
        logger.info(`[auth] Existing ${providerId} authorization revoked`);

        reconnectFailure = { kind: "removed", providerName: provider.name };
        revokedAuthorizationNeedsDurableRemoval = true;
      }

      logger.info(`[auth] Exchanging code for ${providerId} tokens...`);
      let tokens: TokenSet;
      try {
        tokens = await exchangeCode(code, storedCodeVerifier, (issued) => {
          issuedTokens = issued;
        });
        issuedTokens = tokens;
      } catch (exchangeError: unknown) {
        if (existingTokens) {
          if (
            setup.reconnectStrategy === "deauthorize-on-token-limit" &&
            isWahooTokenLimitError(exchangeError)
          ) {
            if (!setup.revokeExistingTokens) {
              throw new Error(
                `${provider.name} requires token-limit deauthorization but has no revocation handler`,
              );
            }
            reconnectFailure = { kind: "preserved", providerName: provider.name };
            logger.info(
              `[auth] ${providerId} rejected replacement for too many active tokens; deauthorizing before retry...`,
            );
            await setup.revokeExistingTokens(existingTokens);
            logger.info(
              `[auth] Existing ${providerId} authorization revoked after token-limit error`,
            );
            reconnectFailure = { kind: "removed", providerName: provider.name };
            revokedAuthorizationNeedsDurableRemoval = true;
            return { error: exchangeError, kind: "failure" };
          }
          reconnectFailure = {
            kind: setup.reconnectStrategy === "revoke-then-replace" ? "removed" : "preserved",
            providerName: provider.name,
          };
        }
        if (existingTokens && setup.reconnectStrategy === "revoke-then-replace") {
          return { error: exchangeError, kind: "failure" };
        }
        throw exchangeError;
      }

      // Auto-link identity when connecting data providers (if getUserIdentity is available)
      if (setup.getUserIdentity && intent !== "data") {
        const identity = await setup.getUserIdentity(tokens.accessToken);
        const externalIdentities: Parameters<
          typeof withAccountErasureUserAndIdentityWriteFence
        >[2][number][] = [
          {
            authProvider: providerId,
            kind: "provider_account",
            providerAccountId: identity.providerAccountId,
          },
        ];
        if (identity.emailVerified && identity.email) {
          externalIdentities.push({ email: identity.email, kind: "email" });
        }

        if (intent === "login") {
          try {
            const targetUserId =
              (await findExistingUserId(db, providerId, identity)) ?? randomUUID();
            const loginResult = await withAccountErasureUserAndIdentityWriteFence(
              db,
              targetUserId,
              externalIdentities,
              async (transaction) => {
                const resolution = await resolveOrCreateUser(
                  transaction,
                  providerId,
                  identity,
                  undefined,
                  {
                    newUserId: targetUserId,
                    requireEmailForNewUser: setup.identityCapabilities?.providesEmail === false,
                  },
                );
                if (resolution.userId !== targetUserId) {
                  throw new Error(
                    `Data-provider identity resolution changed from ${targetUserId} to ${resolution.userId}`,
                  );
                }
                await persistProviderConnection({
                  db: transaction,
                  provider,
                  providerName: provider.name,
                  apiBaseUrl: setup.apiBaseUrl,
                  tokens,
                  userId: resolution.userId,
                });
                return {
                  ...resolution,
                  sessionInfo: await createSession(transaction, resolution.userId),
                };
              },
            );
            const { userId, isNewUser, sessionInfo } = loginResult;

            // Mobile: redirect to app via deep link with session token
            if (stateEntry.mobileScheme && isValidMobileScheme(stateEntry.mobileScheme)) {
              logger.info(
                `[auth] User ${userId} logged in via data provider ${providerId} (mobile)`,
              );
              const exchangeCode = await getMobileAuthExchangeStoreRef().issue({
                kind: "session",
                sessionId: sessionInfo.sessionId,
                isNewUser,
              });
              revokedAuthorizationNeedsDurableRemoval = false;
              return {
                kind: "response",
                response: {
                  kind: "redirect",
                  location: `${stateEntry.mobileScheme}://auth/callback?code=${exchangeCode}`,
                },
              };
            }

            logger.info(`[auth] User ${userId} logged in via data provider ${providerId}`);
            setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
            revokedAuthorizationNeedsDurableRemoval = false;
            return {
              kind: "response",
              response: {
                kind: "redirect",
                location: getPostLoginRedirect(returnTo, isNewUser),
              },
            };
          } catch (loginErr: unknown) {
            if (loginErr instanceof MissingEmailForSignupError) {
              const token = await getPendingEmailSignupStoreRef().issue({
                providerId,
                providerName: provider.name,
                apiBaseUrl: setup.apiBaseUrl,
                identity: {
                  providerAccountId: identity.providerAccountId,
                  email: null,
                  name: identity.name,
                },
                tokens,
                mobileScheme: stateEntry.mobileScheme,
                returnTo,
              });
              return {
                kind: "response",
                response: {
                  body: completeSignupHtml(provider.name, token),
                  kind: "send",
                  statusCode: 200,
                },
              };
            }
            throw loginErr;
          }
        }

        if (linkUserId) {
          if (!identityLockTransaction) {
            throw new Error("Identity lock transaction is required for account linking");
          }
          await lockAndAssertAccountErasureIdentityWriteFence(
            identityLockTransaction,
            externalIdentities,
          );
          await resolveOrCreateUser(operationDb, providerId, identity, linkUserId);
          await persistProviderConnection({
            db: operationDb,
            provider,
            providerName: provider.name,
            apiBaseUrl: setup.apiBaseUrl,
            tokens,
            userId: linkUserId,
          });
          revokedAuthorizationNeedsDurableRemoval = false;
          logger.info(`[auth] Linked ${providerId} to user ${linkUserId}`);
          return {
            kind: "response",
            response: { kind: "redirect", location: "/settings" },
          };
        }
      } else if (setup.getUserIdentity) {
        try {
          const identity = await setup.getUserIdentity(tokens.accessToken);
          if (!identityLockTransaction) {
            throw new Error("Identity lock transaction is required for data-provider linking");
          }
          const identities: Parameters<
            typeof lockAndAssertAccountErasureIdentityWriteFence
          >[1][number][] = [
            {
              authProvider: providerId,
              kind: "provider_account",
              providerAccountId: identity.providerAccountId,
            },
          ];
          if (identity.emailVerified && identity.email) {
            identities.push({ email: identity.email, kind: "email" });
          }
          await lockAndAssertAccountErasureIdentityWriteFence(identityLockTransaction, identities);
          await resolveOrCreateUser(operationDb, providerId, identity, stateUserId);
          logger.info(`[auth] Auto-linked ${providerId} identity to user ${stateUserId}`);
        } catch (identityErr: unknown) {
          if (identityErr instanceof AccountErasureIdentityFencedError) {
            throw identityErr;
          }
          Sentry.captureException(identityErr);
          logger.warn(`[auth] Failed to extract identity from ${providerId}: ${identityErr}`);
        }
        await persistProviderConnection({
          db: operationDb,
          provider,
          providerName: provider.name,
          apiBaseUrl: setup.apiBaseUrl,
          tokens,
          userId: stateUserId,
        });
        revokedAuthorizationNeedsDurableRemoval = false;
      } else {
        await persistProviderConnection({
          db: operationDb,
          provider,
          providerName: provider.name,
          apiBaseUrl: setup.apiBaseUrl,
          tokens,
          userId: stateUserId,
        });
        revokedAuthorizationNeedsDurableRemoval = false;
      }

      if (
        existingTokens &&
        setup.reconnectStrategy !== "revoke-then-replace" &&
        setup.reconnectStrategy !== "deauthorize-on-token-limit"
      ) {
        try {
          await revokeSupersededAuthorization({
            oauthConfig,
            tokens: existingTokens,
            providerId,
            revokeExistingTokens: setup.revokeExistingTokens,
          });
        } catch (revokeError: unknown) {
          logger.error(
            `[auth] Replacement ${providerId} connection succeeded, but superseded authorization cleanup failed: ${
              revokeError instanceof Error ? revokeError.message : String(revokeError)
            }`,
          );
          Sentry.captureException(revokeError);
        }
      }

      return {
        kind: "response",
        response: {
          body: oauthSuccessHtml(
            provider.name,
            `Token expires: ${tokens.expiresAt.toISOString()}`,
            provider.id,
          ),
          kind: "send",
        },
      };
    };

    const knownUserId = intent === "data" ? stateUserId : linkUserId;
    const removeRevokedAuthorizationDurably = async (): Promise<void> => {
      if (!revokedAuthorizationNeedsDurableRemoval) return;
      await withAccountErasureUserWriteFence(db, stateUserId, (transaction) =>
        removeRevokedAuthorization(transaction, providerId, stateUserId),
      );
      revokedAuthorizationNeedsDurableRemoval = false;
    };
    try {
      const completion = knownUserId
        ? await withAccountErasureUserWriteFence(db, knownUserId, (transaction) =>
            completeOAuthConnection(transaction, transaction),
          )
        : await completeOAuthConnection(db);
      if (completion.kind === "failure") {
        throw completion.error;
      }
      await removeRevokedAuthorizationDurably();
      sendDeferredOAuthResponse(res, completion.response);
    } catch (callbackError: unknown) {
      if (revokedAuthorizationNeedsDurableRemoval) {
        try {
          await removeRevokedAuthorizationDurably();
        } catch (cleanupError: unknown) {
          if (
            cleanupError instanceof AccountErasureIdentityFencedError ||
            cleanupError instanceof AccountErasureUserFencedError
          ) {
            throw cleanupError;
          }
          Sentry.captureException(cleanupError, {
            tags: {
              source: "data-provider-oauth",
              operation: "remove-revoked-authorization",
            },
          });
          throw cleanupError;
        }
      }
      if (issuedTokens) {
        try {
          await revokeSupersededAuthorization({
            oauthConfig,
            tokens: issuedTokens,
            providerId,
            revokeExistingTokens: setup.revokeExistingTokens,
          });
        } catch (cleanupError: unknown) {
          Sentry.captureException(cleanupError, {
            tags: {
              source: "data-provider-oauth",
              operation: "revoke-orphan-authorization",
            },
            extra: { providerId, knownUserId },
          });
        }
      }
      throw callbackError;
    }
  } catch (err: unknown) {
    if (
      err instanceof AccountErasureIdentityFencedError ||
      err instanceof AccountErasureUserFencedError
    ) {
      res
        .status(409)
        .type("text/plain")
        .send(
          err instanceof AccountErasureIdentityFencedError
            ? "This identity belongs to an account that is currently being deleted. Try again after deletion completes."
            : "Account deletion is active for this user.",
        );
      return;
    }
    captureException(err);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `[auth] OAuth callback failed for ${resolvedProviderName ?? "unknown provider"}: ${message}`,
      { err },
    );

    // Wahoo-specific: when orphaned tokens on Wahoo's side block new token creation,
    // the user needs to deauthorize the app from the Wahoo mobile app.
    if (message.includes(WAHOO_TOKEN_LIMIT_ERROR)) {
      if (reconnectFailure?.kind === "removed") {
        res
          .status(400)
          .send(
            [
              "<h2>Wahoo authorization reset</h2>",
              "<p>Your previous Wahoo authorization was removed after Wahoo rejected the replacement for too many active tokens.</p>",
              "<p>The old connection is now clean. Start authorization again to receive a fresh grant.</p>",
              '<p><a href="/auth/provider/wahoo">Authorize Wahoo again</a></p>',
            ].join("\n"),
          );
        return;
      }
      res
        .status(400)
        .send(
          [
            "<h2>Wahoo connection blocked by orphaned tokens</h2>",
            "<p>Wahoo limits the number of active tokens per app. Old tokens from a previous session are blocking the new connection.</p>",
            "<p><strong>To fix this:</strong></p>",
            "<ol>",
            "<li>Open the <strong>Wahoo app</strong> on your phone</li>",
            "<li>Open <strong>Authorized Apps</strong> (on some versions: <strong>Today</strong> tab &rarr; <strong>Profile</strong>; newer versions: <strong>Settings</strong> &rarr; <strong>Authorized Apps</strong>)</li>",
            "<li>If this app is listed, open it and tap <strong>Deauthorize</strong></li>",
            '<li>If this app is not listed there, open <a href="https://www.wahooligan.com/profile" target="_blank" rel="noreferrer">wahooligan.com/profile</a> and revoke the connection there</li>',
            '<li>Come back here and <a href="/settings">try connecting Wahoo again</a></li>',
            "</ol>",
          ].join("\n"),
        );
      return;
    }

    if (reconnectFailure?.kind === "preserved") {
      res
        .status(400)
        .send(
          `${reconnectFailure.providerName} reconnect failed. Your existing connection is still active. Please try again later.`,
        );
      return;
    }
    if (reconnectFailure?.kind === "removed") {
      res
        .status(400)
        .send(
          `The previous ${reconnectFailure.providerName} authorization was removed before the new authorization could be completed. Please connect ${reconnectFailure.providerName} again.`,
        );
      return;
    }

    const providerLabel = resolvedProviderName ? ` from ${resolvedProviderName}` : "";
    res.status(500).send(`Token exchange failed — please try again${providerLabel}`);
  }
}

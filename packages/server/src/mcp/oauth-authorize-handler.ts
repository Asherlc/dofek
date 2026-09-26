import {
  InvalidClientError,
  InvalidRequestError,
  MethodNotAllowedError,
  OAuthError,
  ServerError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import express from "express";
import {
  rateLimit as createRateLimiter,
  type Options as RateLimitOptions,
} from "express-rate-limit";
import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates a requested redirect_uri against a registered one.
 *
 * Per RFC 8252 §7.3 (OAuth 2.0 for Native Apps), authorization servers MUST
 * allow any port for loopback redirect URIs (localhost, 127.0.0.1, [::1]) to
 * accommodate native clients that obtain an ephemeral port from the OS. For
 * non-loopback URIs, exact match is required.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) {
    return true;
  }
  let req: URL;
  let reg: URL;
  try {
    req = new URL(requested);
    reg = new URL(registered);
  } catch {
    return false;
  }
  // Port relaxation only applies when both URIs target a loopback host.
  if (!LOOPBACK_HOSTS.has(req.hostname) || !LOOPBACK_HOSTS.has(reg.hostname)) {
    return false;
  }
  // RFC 8252 relaxes the port only — scheme, host, path, and query must still
  // match exactly. Note: hostname must match exactly too (the RFC does not
  // allow localhost↔127.0.0.1 cross-matching).
  return (
    req.protocol === reg.protocol &&
    req.hostname === reg.hostname &&
    req.pathname === reg.pathname &&
    req.search === reg.search
  );
}

/**
 * Parameters that must be validated in order to issue redirects.
 */
const ClientAuthorizationParamsSchema = z.object({
  client_id: z.string(),
  redirect_uri: z
    .string()
    .optional()
    .refine((value) => value === undefined || URL.canParse(value), {
      message: "redirect_uri must be a valid URL",
    }),
});

/**
 * Parameters that must be validated for a successful authorization request.
 * Failure can be reported to the redirect URI.
 */
const RequestAuthorizationParamsSchema = z.object({
  response_type: z.literal("code"),
  code_challenge: z.string(),
  code_challenge_method: z.literal("S256"),
  scope: z.string().optional(),
  state: z.string().optional(),
  resource: z.string().url().optional(),
});

/**
 * Appends the RFC 9207 `iss` parameter to an authorization response URL. The
 * issuer is only added when not already present, so the operation is idempotent.
 */
export function addIss(target: URL | string, issuer: string): string {
  const url = typeof target === "string" ? new URL(target) : target;
  if (url.searchParams.has("iss")) {
    return url.href;
  }
  url.searchParams.set("iss", issuer);
  return url.href;
}

/**
 * Wraps `res.redirect` for the duration of an authorization request so that any
 * callback redirect (success or error) targeting the validated redirect_uri has
 * the RFC 9207 `iss` parameter appended, mirroring upstream MCP v2 behavior.
 */
export function withIssOnCallbackRedirect(
  response: Response,
  redirectUri: string,
  issuer: string,
): void {
  const originalRedirect = response.redirect.bind(response);
  const callback = new URL(redirectUri);
  response.redirect = function redirect(statusOrUrl: string | number, maybeUrl?: string): void {
    const hasExplicitStatus = typeof statusOrUrl === "number";
    const status: number | undefined = hasExplicitStatus ? statusOrUrl : undefined;
    const url = hasExplicitStatus ? (maybeUrl ?? "") : statusOrUrl;

    let target: URL;
    try {
      target = new URL(url, callback);
    } catch {
      if (status === undefined) {
        originalRedirect(url);
      } else {
        originalRedirect(status, url);
      }
      return;
    }

    const resolvedUrl =
      target.origin === callback.origin && target.pathname === callback.pathname
        ? addIss(target, issuer)
        : target.href;

    if (status === undefined) {
      originalRedirect(resolvedUrl);
    } else {
      originalRedirect(status, resolvedUrl);
    }
  };
}

function allowedMethods(allowed: string[]): express.RequestHandler {
  return (request, response, next) => {
    if (allowed.includes(request.method)) {
      next();
      return;
    }
    const error = new MethodNotAllowedError(
      `The method ${request.method} is not allowed for this endpoint`,
    );
    response.status(405).set("Allow", allowed.join(", ")).json(error.toResponseObject());
  };
}

export interface AuthorizationHandlerOptions {
  provider: OAuthServerProvider;
  issuerUrl: URL;
  rateLimit?: Partial<RateLimitOptions> | false;
}

function createErrorRedirect(
  redirectUri: string,
  error: OAuthError,
  issuer: string,
  state?: string,
): string {
  const errorUrl = new URL(redirectUri);
  errorUrl.searchParams.set("error", error.errorCode);
  errorUrl.searchParams.set("error_description", error.message);
  if (error.errorUri) {
    errorUrl.searchParams.set("error_uri", error.errorUri);
  }
  if (state) {
    errorUrl.searchParams.set("state", state);
  }
  return addIss(errorUrl, issuer);
}

interface ResolvedAuthorizationClient {
  redirectUri: string;
  client: OAuthClientInformationFull;
}

async function resolveAuthorizationClient(
  provider: OAuthServerProvider,
  request: express.Request,
): Promise<ResolvedAuthorizationClient> {
  const result = ClientAuthorizationParamsSchema.safeParse(
    request.method === "POST" ? request.body : request.query,
  );
  if (!result.success) {
    throw new InvalidRequestError(result.error.message);
  }
  const clientId = result.data.client_id;
  const client = await provider.clientsStore.getClient(clientId);
  if (!client) {
    throw new InvalidClientError("Invalid client_id");
  }

  const requestedRedirectUri = result.data.redirect_uri;
  if (requestedRedirectUri !== undefined) {
    if (
      !client.redirect_uris.some((registered) =>
        redirectUriMatches(requestedRedirectUri, registered),
      )
    ) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }
    return { redirectUri: requestedRedirectUri, client };
  }

  if (client.redirect_uris.length === 1) {
    const [singleRedirectUri] = client.redirect_uris;
    if (singleRedirectUri) {
      return { redirectUri: singleRedirectUri, client };
    }
  }

  throw new InvalidRequestError(
    "redirect_uri must be specified when client has multiple registered URIs",
  );
}

export function authorizationHandler({
  provider,
  issuerUrl,
  rateLimit: rateLimitConfig,
}: AuthorizationHandlerOptions): express.Router {
  const router = express.Router();
  router.use(allowedMethods(["GET", "POST"]));
  router.use(express.urlencoded({ extended: false }));

  // Apply rate limiting unless explicitly disabled.
  if (rateLimitConfig !== false) {
    router.use(
      createRateLimiter({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100, // 100 requests per windowMs
        standardHeaders: true,
        legacyHeaders: false,
        message: new TooManyRequestsError(
          "You have exceeded the rate limit for authorization requests",
        ).toResponseObject(),
        ...rateLimitConfig,
      }),
    );
  }

  router.all("/", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const issuer = issuerUrl.href;

    // Phase 1: Validate client_id and redirect_uri. Any errors here must be
    // direct responses (not redirects), since we cannot yet trust a redirect
    // target.
    let authorization: ResolvedAuthorizationClient;
    try {
      authorization = await resolveAuthorizationClient(provider, request);
    } catch (error) {
      if (error instanceof OAuthError) {
        const status = error instanceof ServerError ? 500 : 400;
        response.status(status).json(error.toResponseObject());
      } else {
        response.status(500).json(new ServerError("Internal Server Error").toResponseObject());
      }
      return;
    }

    // Phase 2: Validate the remaining parameters. Errors here are reported to
    // the redirect URI. Every redirect (including one made by the provider)
    // must carry the RFC 9207 issuer, so wrap res.redirect for the duration.
    const redirectUri = authorization.redirectUri;
    const client = authorization.client;
    let state: string | undefined;
    withIssOnCallbackRedirect(response, redirectUri, issuer);
    try {
      const parseResult = RequestAuthorizationParamsSchema.safeParse(
        request.method === "POST" ? request.body : request.query,
      );
      if (!parseResult.success) {
        throw new InvalidRequestError(parseResult.error.message);
      }
      const { scope, code_challenge: codeChallenge, resource } = parseResult.data;
      state = parseResult.data.state;
      const requestedScopes = scope !== undefined ? scope.split(" ") : [];
      await provider.authorize(
        client,
        {
          state,
          scopes: requestedScopes,
          redirectUri,
          codeChallenge,
          resource: resource ? new URL(resource) : undefined,
        } satisfies AuthorizationParams,
        response,
      );
    } catch (error) {
      if (error instanceof OAuthError) {
        response.redirect(302, createErrorRedirect(redirectUri, error, issuer, state));
      } else {
        response.redirect(
          302,
          createErrorRedirect(redirectUri, new ServerError("Internal Server Error"), issuer, state),
        );
      }
    }
  });

  return router;
}

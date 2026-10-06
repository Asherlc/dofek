import { createHash } from "node:crypto";
import type { TokenSet } from "../auth/oauth.ts";
import { getTokenUserId } from "../db/token-user-context.ts";
import { logger } from "../logger.ts";
import { captureException } from "./error-reporting.ts";

type ProviderAuthEvent =
  | "tokens_loaded"
  | "tokens_saved"
  | "tokens_missing"
  | "tokens_deleted"
  | "sign_in_started"
  | "sign_in_succeeded"
  | "sign_in_failed"
  | "refresh_started"
  | "refresh_succeeded"
  | "refresh_failed";

export function reportProviderHttpDiagnostic(
  providerId: string,
  response: Response,
  input: RequestInfo | URL,
  init?: RequestInit,
): void {
  if (response.ok) return;

  const url = new URL(input instanceof Request ? input.url : input.toString());
  const challenge =
    response.status === 401 || response.status === 403
      ? (response.headers.get("WWW-Authenticate") ?? "")
      : "";
  const bearerError = /^Bearer\s/i.test(challenge)
    ? /\berror="(invalid_token|insufficient_scope|invalid_request)"/.exec(challenge)?.[1]
    : undefined;
  const category =
    bearerError ??
    (response.status === 401
      ? "unauthorized"
      : response.status === 403
        ? "forbidden"
        : response.status === 429
          ? "rate_limited"
          : "http_error");
  const diagnostic = {
    event: "http_failed",
    providerId,
    userId: getTokenUserId(),
    origin: url.origin,
    // Paths can contain account IDs or credentials; queries and fragments are omitted entirely.
    endpointHash: createHash("sha256").update(url.pathname).digest("hex"),
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    statusCode: response.status,
    category,
  };
  logger.warn(`[provider-diagnostics] ${JSON.stringify(diagnostic)}`);
  if (response.status === 401 || response.status === 403) {
    captureException(
      new Error(`Provider ${providerId} HTTP authorization rejected (${response.status})`),
      {
        tags: { provider: providerId, operation: "provider-http", category },
        extra: diagnostic,
        level: "warning",
      },
    );
  }
}

export function reportProviderAuthDiagnostic(
  providerId: string,
  event: ProviderAuthEvent,
  userId?: string,
  tokens?: Pick<TokenSet, "expiresAt" | "refreshToken">,
): void {
  const diagnostic = {
    event,
    providerId,
    userId: userId ?? getTokenUserId(),
    ...(tokens
      ? {
          expiresAt: tokens.expiresAt.toISOString(),
          expiresInSeconds: Math.floor((tokens.expiresAt.getTime() - Date.now()) / 1000),
          hasRefreshToken: Boolean(tokens.refreshToken),
        }
      : {}),
  };
  const failed = event === "sign_in_failed" || event === "refresh_failed";
  const message = `[provider-diagnostics] ${JSON.stringify(diagnostic)}`;
  if (failed) {
    logger.warn(message);
    captureException(new Error(`Provider ${providerId} ${event}`), {
      tags: { provider: providerId, operation: event },
      extra: diagnostic,
      level: "warning",
    });
  } else {
    logger.debug(message);
  }
}

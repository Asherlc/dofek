import { createHash } from "node:crypto";
import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import { getTokenUserId } from "../db/token-user-context.ts";
import { afterCommit } from "../db/transaction-effects.ts";
import { logger } from "../logger.ts";
import { captureException } from "./error-reporting.ts";
import {
  getProviderTokenDiagnostic,
  setProviderTokenDiagnostic,
} from "./provider-token-diagnostic-context.ts";

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

const authErrorCodeSchema = z.enum([
  "invalid_token",
  "invalid_grant",
  "insufficient_scope",
  "invalid_request",
  "access_denied",
  "unauthorized",
  "forbidden",
  "invalid",
  "expired",
  "missing",
]);
const authErrorSchema = z.object({
  code: authErrorCodeSchema,
  resource: z
    .enum(["AccessToken", "RefreshToken", "Athlete", "Application"])
    .optional()
    .catch(undefined),
  field: z.enum(["access_token", "refresh_token", "scope"]).optional().catch(undefined),
});
const authResponseSchema = z.object({
  error: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
});

async function readAuthErrors(
  response: Response,
  providerId: string,
): Promise<Array<z.infer<typeof authErrorSchema>>> {
  if (!response.headers.get("Content-Type")?.includes("json")) return [];
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      captureException(new Error("Unable to read provider authorization diagnostic response"), {
        tags: { provider: providerId, operation: "provider-http-diagnostics" },
      });
    }
    return [];
  }
  const parsed = authResponseSchema.safeParse(body);
  if (!parsed.success) return [];
  const errors: Array<z.infer<typeof authErrorSchema>> = [];
  const code = authErrorCodeSchema.safeParse(parsed.data.error);
  if (code.success) errors.push({ code: code.data });
  parsed.data.errors?.forEach((entry) => {
    const error = authErrorSchema.safeParse(entry);
    if (error.success) errors.push(error.data);
  });
  return errors;
}

export async function reportProviderHttpDiagnostic(
  providerId: string,
  response: Response,
  input: RequestInfo | URL,
  init?: RequestInit,
  userId?: string | null,
  requestStartedAtMs?: number,
): Promise<void> {
  if (response.ok) return;

  const responseAtMs = Date.now();
  const scopedUserId = userId ?? getTokenUserId();
  const tokens = getProviderTokenDiagnostic(providerId, scopedUserId);
  const authErrors =
    response.status === 401 || response.status === 403
      ? await readAuthErrors(response, providerId)
      : [];

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
    userId: scopedUserId,
    origin: url.origin,
    // Paths can contain account IDs or credentials; queries and fragments are omitted entirely.
    endpointHash: createHash("sha256").update(url.pathname).digest("hex"),
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    statusCode: response.status,
    category,
    ...(requestStartedAtMs !== undefined
      ? {
          requestStartedAt: new Date(requestStartedAtMs).toISOString(),
          requestDurationMs: responseAtMs - requestStartedAtMs,
        }
      : {}),
    ...(tokens
      ? {
          tokenExpiresAt: tokens.expiresAt,
          hasRefreshToken: tokens.hasRefreshToken,
          tokenExpiresInSecondsAtResponse: Math.floor(
            (Date.parse(tokens.expiresAt) - responseAtMs) / 1000,
          ),
          ...(requestStartedAtMs !== undefined
            ? {
                tokenExpiresInSecondsAtRequestStart: Math.floor(
                  (Date.parse(tokens.expiresAt) - requestStartedAtMs) / 1000,
                ),
              }
            : {}),
        }
      : {}),
    ...(authErrors.length > 0 ? { authErrors } : {}),
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
  const updateTokenDiagnostic = () => {
    const scopedUserId = userId ?? getTokenUserId();
    if (tokens) {
      setProviderTokenDiagnostic(providerId, scopedUserId, {
        expiresAt: tokens.expiresAt.toISOString(),
        hasRefreshToken: Boolean(tokens.refreshToken),
      });
    } else if (event === "tokens_missing" || event === "tokens_deleted") {
      setProviderTokenDiagnostic(providerId, scopedUserId, undefined);
    }
  };
  if (failed) {
    logger.warn(message);
    captureException(new Error(`Provider ${providerId} ${event}`), {
      tags: { provider: providerId, operation: event },
      extra: diagnostic,
      level: "warning",
    });
  } else {
    if (
      event === "tokens_saved" ||
      event === "tokens_deleted" ||
      event === "sign_in_succeeded" ||
      event === "refresh_succeeded"
    ) {
      afterCommit(() => {
        updateTokenDiagnostic();
        logger.debug(message);
      });
    } else {
      updateTokenDiagnostic();
      logger.debug(message);
    }
  }
}

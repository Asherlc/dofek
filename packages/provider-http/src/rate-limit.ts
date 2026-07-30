import type { AdaptiveRateLimitStore } from "./rate-limit-types.ts";
import {
  type ProviderHttpErrorScope,
  ProviderRateLimitError,
  type ProviderRateLimitScope,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "./rate-limit-types.ts";

export type {
  AdaptiveRateLimitStore,
  ProviderHttpErrorScope,
  ProviderRateLimitErrorOptions,
  ProviderRateLimitScope,
  ProviderRequestTimeoutErrorOptions,
  ProviderServiceUnavailableErrorOptions,
} from "./rate-limit-types.ts";
export { ProviderRateLimitError, ProviderRequestTimeoutError, ProviderServiceUnavailableError };

export interface FetchRateLimitHandlingOptions {
  createRateLimitError: (response: Response, responseBody: string) => Error;
  createServiceUnavailableError?: (response: Response, responseBody: string) => Error;
}

export interface RateLimitAwareFetchOptions {
  providerId: string;
  scope?: ProviderRateLimitScope;
  userId?: string | null;
  createRateLimitError?: (response: Response, responseBody: string) => Error;
  createServiceUnavailableError?: (response: Response, responseBody: string) => Error;
  adaptiveStore?: AdaptiveRateLimitStore;
}

const rateLimitAwareFetches = new WeakSet<typeof globalThis.fetch>();
export const PROVIDER_HTTP_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

function callerAbortSignal(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): AbortSignal | undefined {
  if (init?.signal) return init.signal;
  return input instanceof Request ? input.signal : undefined;
}

/**
 * Parses an HTTP `Retry-After` header value, which may be either a number of
 * seconds or an HTTP-date. Returns the delay in seconds, or null when absent or
 * unparseable.
 */
export function parseRetryAfterHeader(header: string | null | undefined): number | null {
  if (!header) return null;

  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) return null;

  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

export function isServiceUnavailableStatus(statusCode: number): boolean {
  return statusCode === 502 || statusCode === 503 || statusCode === 504;
}

const PROVIDER_CONNECT_FAILURE_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ENETUNREACH"]);

function errorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return undefined;
  }
  return error.cause;
}

export function isProviderConnectFailure(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current.name === "ConnectTimeoutError") {
      return true;
    }

    const code =
      typeof current === "object" && current !== null && "code" in current ? current.code : null;
    if (typeof code === "string" && PROVIDER_CONNECT_FAILURE_CODES.has(code)) {
      return true;
    }

    current = errorCause(current);
  }

  return false;
}

export async function fetchWithRateLimitHandling(
  fetchFn: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: FetchRateLimitHandlingOptions,
): Promise<Response> {
  const response = init === undefined ? await fetchFn(input) : await fetchFn(input, init);
  if (response.status === 429) {
    const responseBody = await response.text();
    throw options.createRateLimitError(response, responseBody);
  }
  if (isServiceUnavailableStatus(response.status)) {
    const responseBody = await response.text();
    const createServiceUnavailableError =
      options.createServiceUnavailableError ??
      ((unavailableResponse, unavailableResponseBody) =>
        createDefaultServiceUnavailableError(
          "unknown",
          "provider",
          null,
          unavailableResponse,
          unavailableResponseBody,
        ));
    throw createServiceUnavailableError(response, responseBody);
  }
  return response;
}

function createDefaultRateLimitError(
  providerId: string,
  scope: ProviderRateLimitScope,
  userId: string | null,
  response: Response,
  responseBody: string,
): ProviderRateLimitError {
  return new ProviderRateLimitError({
    message: `${providerId} API rate limit exceeded (${response.status}): ${responseBody}`,
    providerId,
    statusCode: response.status,
    responseBody,
    scope,
    userId,
    retryAfterSeconds: parseRetryAfterHeader(response.headers.get("Retry-After")),
  });
}

function createDefaultServiceUnavailableError(
  providerId: string,
  scope: ProviderHttpErrorScope,
  userId: string | null,
  response: Response,
  responseBody: string,
): ProviderServiceUnavailableError {
  return new ProviderServiceUnavailableError({
    message: `${providerId} API service unavailable (${response.status}): ${responseBody}`,
    providerId,
    statusCode: response.status,
    responseBody,
    scope,
    userId,
    retryAfterSeconds: parseRetryAfterHeader(response.headers.get("Retry-After")),
  });
}

export function createRateLimitAwareFetch(
  fetchFn: typeof globalThis.fetch,
  options: RateLimitAwareFetchOptions,
): typeof globalThis.fetch {
  if (rateLimitAwareFetches.has(fetchFn)) return fetchFn;

  const rateLimitFetch: typeof globalThis.fetch = async (input, init) => {
    const scope = options.scope ?? "provider";
    const userId = options.userId ?? null;
    if (options.adaptiveStore) {
      await options.adaptiveStore.awaitAdmission(options.providerId, scope, userId);
    }

    const timeoutSignal = AbortSignal.timeout(PROVIDER_HTTP_REQUEST_TIMEOUT_MS);
    const upstreamSignal = callerAbortSignal(input, init);
    const signal = upstreamSignal
      ? AbortSignal.any([upstreamSignal, timeoutSignal])
      : timeoutSignal;

    try {
      const response = await fetchWithRateLimitHandling(
        fetchFn,
        input,
        { ...init, signal },
        {
          createRateLimitError:
            options.createRateLimitError ??
            ((response, responseBody) =>
              createDefaultRateLimitError(
                options.providerId,
                scope,
                userId,
                response,
                responseBody,
              )),
          createServiceUnavailableError:
            options.createServiceUnavailableError ??
            ((response, responseBody) =>
              createDefaultServiceUnavailableError(
                options.providerId,
                scope,
                userId,
                response,
                responseBody,
              )),
        },
      );

      if (options.adaptiveStore && response.ok) {
        await options.adaptiveStore.recordSuccess(
          options.providerId,
          scope,
          userId,
          response.headers,
        );
      }

      return response;
    } catch (err) {
      if (timeoutSignal.aborted && signal.reason === timeoutSignal.reason) {
        throw new ProviderRequestTimeoutError({
          cause: err,
          providerId: options.providerId,
          scope,
          timeoutMs: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
          userId,
        });
      }
      if (isProviderConnectFailure(err)) {
        throw new ProviderRequestTimeoutError({
          cause: err,
          providerId: options.providerId,
          scope,
          timeoutMs: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
          userId,
        });
      }
      if (options.adaptiveStore && err instanceof ProviderRateLimitError) {
        await options.adaptiveStore.recordRateLimit(err);
      }
      throw err;
    }
  };
  rateLimitAwareFetches.add(rateLimitFetch);
  return rateLimitFetch;
}

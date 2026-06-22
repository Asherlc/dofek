import type { AdaptiveRateLimitStore } from "./rate-limit-types.ts";
import {
  type ProviderHttpErrorScope,
  ProviderRateLimitError,
  type ProviderRateLimitScope,
  ProviderServiceUnavailableError,
} from "./rate-limit-types.ts";

export type {
  AdaptiveRateLimitStore,
  ProviderHttpErrorScope,
  ProviderRateLimitErrorOptions,
  ProviderRateLimitScope,
  ProviderServiceUnavailableErrorOptions,
} from "./rate-limit-types.ts";
export { ProviderRateLimitError, ProviderServiceUnavailableError };

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

    try {
      const response = await fetchWithRateLimitHandling(fetchFn, input, init, {
        createRateLimitError:
          options.createRateLimitError ??
          ((response, responseBody) =>
            createDefaultRateLimitError(options.providerId, scope, userId, response, responseBody)),
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
      });

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
      if (options.adaptiveStore && err instanceof ProviderRateLimitError) {
        await options.adaptiveStore.recordRateLimit(err);
      }
      throw err;
    }
  };
  rateLimitAwareFetches.add(rateLimitFetch);
  return rateLimitFetch;
}

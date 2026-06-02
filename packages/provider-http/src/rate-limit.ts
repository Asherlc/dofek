export interface ProviderRateLimitErrorOptions {
  message: string;
  providerId: string;
  statusCode: number;
  responseBody: string;
  scope?: ProviderRateLimitScope;
  userId?: string | null;
  retryAfterSeconds?: number | null;
}

export type ProviderRateLimitScope = "provider" | "user";

export class ProviderRateLimitError extends Error {
  readonly providerId: string;
  readonly statusCode: number;
  readonly responseBody: string;
  readonly scope: ProviderRateLimitScope;
  readonly userId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(options: ProviderRateLimitErrorOptions) {
    super(options.message);
    this.name = "ProviderRateLimitError";
    this.providerId = options.providerId;
    this.statusCode = options.statusCode;
    this.responseBody = options.responseBody;
    this.scope = options.scope ?? "provider";
    this.userId = options.userId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export interface FetchRateLimitHandlingOptions {
  createRateLimitError: (response: Response, responseBody: string) => Error;
}

export interface RateLimitAwareFetchOptions {
  providerId: string;
  scope?: ProviderRateLimitScope;
  userId?: string | null;
  createRateLimitError?: (response: Response, responseBody: string) => Error;
}

const rateLimitAwareFetches = new WeakSet<typeof globalThis.fetch>();

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  if (!header) return null;

  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) return null;

  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
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
    retryAfterSeconds: retryAfterSeconds(response),
  });
}

export function createRateLimitAwareFetch(
  fetchFn: typeof globalThis.fetch,
  options: RateLimitAwareFetchOptions,
): typeof globalThis.fetch {
  if (rateLimitAwareFetches.has(fetchFn)) return fetchFn;

  const rateLimitFetch: typeof globalThis.fetch = (input, init) =>
    fetchWithRateLimitHandling(fetchFn, input, init, {
      createRateLimitError:
        options.createRateLimitError ??
        ((response, responseBody) =>
          createDefaultRateLimitError(
            options.providerId,
            options.scope ?? "provider",
            options.userId ?? null,
            response,
            responseBody,
          )),
    });
  rateLimitAwareFetches.add(rateLimitFetch);
  return rateLimitFetch;
}

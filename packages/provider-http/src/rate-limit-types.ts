export type ProviderRateLimitScope = "provider" | "user";
export type ProviderHttpErrorScope = ProviderRateLimitScope;

export interface ProviderRateLimitErrorOptions {
  message: string;
  providerId: string;
  statusCode: number;
  responseBody: string;
  scope?: ProviderRateLimitScope;
  userId?: string | null;
  retryAfterSeconds?: number | null;
}

export interface ProviderServiceUnavailableErrorOptions {
  message: string;
  providerId: string;
  statusCode: number;
  responseBody: string;
  scope?: ProviderHttpErrorScope;
  userId?: string | null;
  retryAfterSeconds?: number | null;
}

export interface ProviderRequestTimeoutErrorOptions {
  cause?: unknown;
  providerId: string;
  scope?: ProviderHttpErrorScope;
  timeoutMs: number;
  userId?: string | null;
}

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

export class ProviderServiceUnavailableError extends Error {
  readonly providerId: string;
  readonly statusCode: number;
  readonly responseBody: string;
  readonly scope: ProviderHttpErrorScope;
  readonly userId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(options: ProviderServiceUnavailableErrorOptions) {
    super(options.message);
    this.name = "ProviderServiceUnavailableError";
    this.providerId = options.providerId;
    this.statusCode = options.statusCode;
    this.responseBody = options.responseBody;
    this.scope = options.scope ?? "provider";
    this.userId = options.userId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export class ProviderRequestTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  readonly providerId: string;
  readonly scope: ProviderHttpErrorScope;
  readonly timeoutMs: number;
  readonly userId: string | null;

  constructor(options: ProviderRequestTimeoutErrorOptions) {
    super(`${options.providerId} provider request timed out after ${options.timeoutMs}ms`, {
      cause: options.cause,
    });
    this.name = "ProviderRequestTimeoutError";
    this.providerId = options.providerId;
    this.scope = options.scope ?? "provider";
    this.timeoutMs = options.timeoutMs;
    this.userId = options.userId ?? null;
  }
}

export interface AdaptiveRateLimitStore {
  awaitAdmission(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
  ): Promise<void>;
  recordSuccess(
    providerId: string,
    scope: ProviderRateLimitScope,
    userId: string | null,
    responseHeaders?: Headers,
  ): Promise<void>;
  recordRateLimit(error: ProviderRateLimitError): Promise<void>;
  getLearnedCooldownSeconds(providerId: string): Promise<number | null>;
}

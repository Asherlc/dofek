import { z } from "zod";

export const providerAuthFailureReasons = [
  "access_token_expired",
  "refresh_token_revoked",
  "session_expired",
  "authorization_failed",
  "authentication_failed",
] as const;

export type ProviderAuthFailureReason = (typeof providerAuthFailureReasons)[number];

export const providerAuthFailureReasonSchema = z.enum(providerAuthFailureReasons);

export class ProviderAuthError extends Error {
  readonly authFailureReason: ProviderAuthFailureReason;

  constructor(
    authFailureReason: ProviderAuthFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.authFailureReason = authFailureReason;
  }
}

export class AccessTokenExpiredError extends ProviderAuthError {
  constructor(providerName: string, options?: ErrorOptions) {
    super("access_token_expired", `${providerName} access token expired.`, options);
  }
}

export class RefreshTokenRevokedError extends ProviderAuthError {
  constructor(providerName: string, options?: ErrorOptions) {
    super(
      "refresh_token_revoked",
      `${providerName} refresh token was revoked or expired.`,
      options,
    );
  }
}

export class ProviderSessionExpiredError extends ProviderAuthError {
  constructor(providerName: string, options?: ErrorOptions) {
    super("session_expired", `${providerName} session expired.`, options);
  }
}

export class ProviderAuthorizationFailedError extends ProviderAuthError {
  constructor(providerName: string, options?: ErrorOptions) {
    super("authorization_failed", `${providerName} authorization failed.`, options);
  }
}

export class ProviderAuthenticationFailedError extends ProviderAuthError {
  constructor(providerName: string, options?: ErrorOptions) {
    super("authentication_failed", `${providerName} authentication failed.`, options);
  }
}

export class ProviderTokenRejectedError extends ProviderAuthError {
  constructor(providerName: string, instructions: string, options?: ErrorOptions) {
    super("authentication_failed", `${providerName} rejected this token. ${instructions}`, options);
  }
}

export class ProviderInvalidCredentialsError extends ProviderAuthError {
  constructor(providerName: string, options?: ErrorOptions) {
    super(
      "authentication_failed",
      `${providerName} login failed: invalid email or password.`,
      options,
    );
  }
}

export class ProviderStoredIdentityMissingError extends ProviderAuthError {
  constructor(providerName: string, identityName: string, options?: ErrorOptions) {
    super("authentication_failed", `${providerName} ${identityName} not found.`, options);
  }
}

export class ProviderStoredIdentityInvalidError extends ProviderAuthError {
  constructor(message: string, options?: ErrorOptions) {
    super("authentication_failed", message, options);
  }
}

export function authFailureReasonFromError(error: unknown): ProviderAuthFailureReason | undefined {
  const visitedErrors = new Set<unknown>();
  let currentError: unknown = error;

  while (currentError !== undefined && currentError !== null && !visitedErrors.has(currentError)) {
    visitedErrors.add(currentError);
    if (currentError instanceof ProviderAuthError) {
      return currentError.authFailureReason;
    }
    currentError =
      currentError instanceof Error && "cause" in currentError ? currentError.cause : undefined;
  }

  return undefined;
}

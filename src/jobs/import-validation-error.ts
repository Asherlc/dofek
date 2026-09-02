import { UnrecoverableError } from "bullmq";

export const APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME = "AppleHealthImportValidationError";

export function createAppleHealthImportValidationError(message: string): UnrecoverableError {
  const error = new UnrecoverableError(message);
  error.name = APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME;
  return error;
}

export function isAppleHealthImportValidationError(error: unknown): error is UnrecoverableError {
  return (
    error instanceof UnrecoverableError && error.name === APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME
  );
}

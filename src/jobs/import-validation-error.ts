import {
  APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME,
  STRONG_CSV_IMPORT_VALIDATION_ERROR_NAME,
} from "@dofek/format/user-facing-error";
import { UnrecoverableError } from "bullmq";

export { APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME, STRONG_CSV_IMPORT_VALIDATION_ERROR_NAME };

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

export function createStrongCsvImportValidationError(message: string): UnrecoverableError {
  const error = new UnrecoverableError(message);
  error.name = STRONG_CSV_IMPORT_VALIDATION_ERROR_NAME;
  return error;
}

export function isStrongCsvImportValidationError(error: unknown): error is UnrecoverableError {
  return (
    error instanceof UnrecoverableError && error.name === STRONG_CSV_IMPORT_VALIDATION_ERROR_NAME
  );
}

export function isImportValidationError(error: unknown): error is UnrecoverableError {
  return isAppleHealthImportValidationError(error) || isStrongCsvImportValidationError(error);
}

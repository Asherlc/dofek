import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  createClimbingImportValidationError,
  createStrongCsvImportValidationError,
  isImportValidationError,
  isStrongCsvImportValidationError,
} from "./import-validation-error.ts";

describe("import validation errors", () => {
  it("creates a terminal climbing export rejection with its actionable message", () => {
    const error = createClimbingImportValidationError("8a.nu row 3: date is invalid");
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.name).toBe("ClimbingImportValidationError");
    expect(error.message).toBe("8a.nu row 3: date is invalid");
    expect(isImportValidationError(error)).toBe(true);
  });
  it("creates a terminal Strong CSV validation error", () => {
    const error = createStrongCsvImportValidationError("Missing Weight Unit");

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.name).toBe("StrongCsvValidationError");
    expect(isStrongCsvImportValidationError(error)).toBe(true);
    expect(isImportValidationError(error)).toBe(true);
  });

  it("does not classify unrelated terminal failures as validation", () => {
    expect(isImportValidationError(new UnrecoverableError("R2 unavailable"))).toBe(false);
  });
});

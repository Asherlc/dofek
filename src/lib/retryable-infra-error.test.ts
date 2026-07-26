import { describe, expect, it } from "vitest";
import { isRetryableInfraError } from "./retryable-infra-error.ts";

describe("isRetryableInfraError", () => {
  it("retries native provider request timeouts", () => {
    expect(
      isRetryableInfraError(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      ),
    ).toBe(true);
  });

  it("does not treat caller cancellation as an infrastructure failure", () => {
    expect(isRetryableInfraError(new DOMException("Caller cancelled", "AbortError"))).toBe(false);
  });
});

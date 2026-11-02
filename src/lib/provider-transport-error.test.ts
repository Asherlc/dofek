import {
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { describe, expect, it } from "vitest";
import {
  findProviderTransportError,
  isRetryingOpenBetaTransportFailure,
  isRetryingZeppHttp500ServiceUnavailableError,
  isZeppHttp500ServiceUnavailableError,
  redactProviderServiceUnavailableError,
} from "./provider-transport-error.ts";

describe("redactProviderServiceUnavailableError", () => {
  it("preserves outage classification and retry metadata without response content", () => {
    const original = new ProviderServiceUnavailableError({
      providerId: "ultrahuman",
      statusCode: 525,
      message: "private body",
      responseBody: "private body",
      scope: "user",
      userId: "user-1",
      retryAfterSeconds: 30,
    });
    const error = redactProviderServiceUnavailableError(original, "Token validation failed");
    expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(error).toMatchObject({
      providerId: "ultrahuman",
      statusCode: 525,
      responseBody: "",
      scope: "user",
      userId: "user-1",
      retryAfterSeconds: 30,
      message: "Token validation failed (525). Try again.",
    });
    expect(error).not.toHaveProperty("cause");
    expect(original.responseBody).toBe("private body");
  });
  it.each([
    new SyntaxError("invalid JSON"),
    new ProviderRequestTimeoutError({ providerId: "ultrahuman", timeoutMs: 120000 }),
    "unexpected",
  ])("preserves other errors unchanged: %s", (error) => {
    expect(redactProviderServiceUnavailableError(error, "Token validation failed")).toBe(error);
  });
});

describe("findProviderTransportError", () => {
  it.each([
    new ProviderServiceUnavailableError({
      providerId: "openbeta",
      statusCode: 504,
      message: "timeout",
      responseBody: "timeout",
    }),
    new ProviderRequestTimeoutError({ providerId: "openbeta", timeoutMs: 120_000 }),
  ])("finds typed transport errors through wrapper causes", (error) => {
    expect(findProviderTransportError(new Error("sync failed", { cause: error }))).toBe(error);
  });

  it("does not classify an untyped error or cyclic cause as a provider timeout", () => {
    const error = new Error("timeout");
    error.cause = error;
    expect(findProviderTransportError(error)).toBeNull();
    expect(findProviderTransportError("timeout")).toBeNull();
  });
});

describe("isZeppHttp500ServiceUnavailableError", () => {
  it.each([
    ["amazfit-zepp", 500, true],
    ["amazfit-zepp", 503, false],
    ["openbeta", 500, false],
  ] as const)("classifies %s HTTP %s as %s", (providerId, statusCode, expected) => {
    const error = new ProviderServiceUnavailableError({
      providerId,
      statusCode,
      message: "unavailable",
      responseBody: "unavailable",
    });
    expect(isZeppHttp500ServiceUnavailableError(error)).toBe(expected);
    expect(isZeppHttp500ServiceUnavailableError(new Error("wrapped", { cause: error }))).toBe(
      false,
    );
  });
  it("does not classify untyped Zepp errors", () => {
    expect(isZeppHttp500ServiceUnavailableError(new Error("Zepp HTTP 500"))).toBe(false);
  });
});

describe("isRetryingOpenBetaTransportFailure", () => {
  it.each([
    [1, 288, true],
    [287, 288, true],
    [288, 288, false],
    [289, 288, false],
    [1, undefined, false],
    [1, 1, false],
    [1, 2, true],
  ])("classifies attempt %s of %s as retrying=%s", (attemptNumber, attempts, expected) => {
    const error = new ProviderRequestTimeoutError({ providerId: "openbeta", timeoutMs: 120000 });
    expect(
      isRetryingOpenBetaTransportFailure(
        error,
        Number(attemptNumber),
        attempts === undefined ? undefined : Number(attempts),
      ),
    ).toBe(expected);
    expect(
      isRetryingOpenBetaTransportFailure(
        new Error("wrapper", { cause: error }),
        Number(attemptNumber),
        attempts === undefined ? undefined : Number(attempts),
      ),
    ).toBe(expected);
  });
  it("does not classify other providers or untyped errors as OpenBeta retries", () => {
    expect(
      isRetryingOpenBetaTransportFailure(
        new ProviderRequestTimeoutError({ providerId: "wahoo", timeoutMs: 120000 }),
        1,
        288,
      ),
    ).toBe(false);
    expect(isRetryingOpenBetaTransportFailure(new Error("timeout"), 1, 288)).toBe(false);
  });
});

describe("isRetryingZeppHttp500ServiceUnavailableError", () => {
  it.each([
    [1, 288, true],
    [287, 288, true],
    [288, 288, false],
    [289, 288, false],
    [1, undefined, false],
    [1, 1, false],
    [1, 2, true],
    [1, 0, false],
  ] as const)(
    "classifies one-based attempt %s of %s as retrying=%s",
    (attemptNumber, attempts, expected) => {
      const error = new ProviderServiceUnavailableError({
        providerId: "amazfit-zepp",
        statusCode: 500,
        message: "Zepp unavailable",
        responseBody: "outage",
      });
      expect(isRetryingZeppHttp500ServiceUnavailableError(error, attemptNumber, attempts)).toBe(
        expected,
      );
      expect(
        isRetryingZeppHttp500ServiceUnavailableError(
          new Error("wrapped", { cause: error }),
          attemptNumber,
          attempts,
        ),
      ).toBe(false);
    },
  );

  it.each([
    new ProviderServiceUnavailableError({
      providerId: "amazfit-zepp",
      statusCode: 503,
      message: "outage",
      responseBody: "outage",
    }),
    new ProviderServiceUnavailableError({
      providerId: "openbeta",
      statusCode: 500,
      message: "outage",
      responseBody: "outage",
    }),
    new ProviderRequestTimeoutError({ providerId: "amazfit-zepp", timeoutMs: 120000 }),
    new Error("Zepp HTTP500"),
  ])("preserves the strict direct Zepp500 error scope: %s", (error) => {
    expect(isRetryingZeppHttp500ServiceUnavailableError(error, 1, 288)).toBe(false);
  });
});

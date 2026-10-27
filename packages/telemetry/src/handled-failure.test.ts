import { describe, expect, it } from "vitest";
import { classifyHandledFailure } from "./handled-failure.ts";

describe("classifyHandledFailure", () => {
  it.each([
    ["fetch failed: cancelled", "cancelled"],
    ["fetch failed: canceled", "cancelled"],
    ["The operation was aborted.", "cancelled"],
    ["fetch failed: The Internet connection appears to be offline.", "offline"],
  ])("classifies known transport outcome %s", (message, kind) => {
    expect(classifyHandledFailure(new Error(message))).toBe(kind);
  });

  it("recognizes native aborts and wrapped transport causes", () => {
    const abort = new Error("Aborted");
    abort.name = "AbortError";
    expect(classifyHandledFailure(abort)).toBe("cancelled");
    expect(classifyHandledFailure(new Error("TRPCClientError", { cause: abort }))).toBe(
      "cancelled",
    );
  });

  it("requires an explicit credential marker rather than guessing from HTTP status", () => {
    expect(classifyHandledFailure({ data: { handledFailure: "invalid_credentials" } })).toBe(
      "invalid_credentials",
    );
    expect(classifyHandledFailure({ data: { code: "BAD_REQUEST", httpStatus: 403 } })).toBeNull();
    expect(classifyHandledFailure(new Error("Invalid email or password"))).toBeNull();
  });

  it.each([
    new Error("HTTP 403"),
    new Error("fetch failed: The request timed out."),
    new Error("Non-JSON response: 404 page not found"),
    new Error("Failed to write value."),
    new Error("JSON contains cancelled"),
    new TypeError("Failed to fetch"),
    new SyntaxError("fetch failed: cancelled"),
  ])("keeps unexpected failure %# reportable", (error) => {
    expect(classifyHandledFailure(error)).toBeNull();
  });

  it("does not hide a parse failure behind a transport cause", () => {
    expect(
      classifyHandledFailure(
        new SyntaxError("Invalid response", { cause: new Error("fetch failed: cancelled") }),
      ),
    ).toBeNull();
  });

  it("terminates cyclic cause chains and tolerates missing evidence", () => {
    const error = new Error("unknown");
    error.cause = error;
    expect(classifyHandledFailure(error)).toBeNull();
    expect(classifyHandledFailure(null)).toBeNull();
    expect(classifyHandledFailure(undefined)).toBeNull();
  });
});

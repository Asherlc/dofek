import { describe, expect, it } from "vitest";
import { classifyHandledFailure } from "./handled-failure.ts";

describe("classifyHandledFailure", () => {
  it("classifies the observed auth restore connection loss through its underlying cause", () => {
    const error = new Error("fetch failed: The network connection was lost.");
    expect(classifyHandledFailure(error, "auth-state-restore")).toBe("connection_lost");
    expect(
      classifyHandledFailure(new Error("Request failed", { cause: error }), "auth-state-restore"),
    ).toBe("connection_lost");
  });

  it.each([undefined, "react-query", "auth-saved-user-restore", "auth-state-restore-other"])(
    "retains connection loss outside the approved auth restore source (%s)",
    (source) => {
      expect(
        classifyHandledFailure(new Error("fetch failed: The network connection was lost."), source),
      ).toBeNull();
    },
  );

  it.each([
    new Error("Failed to write value."),
    new Error("HTTP 403"),
    new Error("Unknown native failure"),
    "unknown failure",
    new SyntaxError("fetch failed: The network connection was lost."),
    Object.assign(new Error("fetch failed: The network connection was lost."), {
      name: "ZodError",
    }),
  ])("retains unexpected cause %# under an auth connection-loss wrapper", (cause) => {
    expect(
      classifyHandledFailure(
        new Error("fetch failed: The network connection was lost.", { cause }),
        "auth-state-restore",
      ),
    ).toBeNull();
  });

  it.each([
    new Error("The network connection was lost."),
    new Error("fetch failed: UnexpectedException: The network connection was lost."),
    new Error("fetch failed: The network connection was lost.; HTTP 403"),
    new SyntaxError("Invalid JSON", {
      cause: new Error("fetch failed: The network connection was lost."),
    }),
  ])("retains unapproved or malformed auth outcome %#", (error) => {
    expect(classifyHandledFailure(error, "auth-state-restore")).toBeNull();
  });

  it("retains a cyclic auth connection-loss cause", () => {
    const error = new Error("fetch failed: The network connection was lost.");
    error.cause = error;
    expect(classifyHandledFailure(error, "auth-state-restore")).toBeNull();
  });

  it.each([new Error("Failed to write value."), new Error("HTTP 403"), "unknown failure"])(
    "keeps an unexpected underlying cause reportable under a cancellation wrapper",
    (cause) => {
      expect(classifyHandledFailure(new Error("fetch failed: cancelled", { cause }))).toBeNull();
    },
  );
  it.each([
    new SyntaxError("fetch failed: cancelled"),
    Object.assign(new Error("fetch failed: cancelled"), { name: "ZodError" }),
  ])(
    "retains a wrapped parse/schema failure even when its copied message matches transport",
    (cause) => {
      expect(classifyHandledFailure(new Error(cause.message, { cause }))).toBeNull();
    },
  );
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

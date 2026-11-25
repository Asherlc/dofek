import { describe, expect, it, vi } from "vitest";
import {
  classifyHandledFailure,
  guardTrpcHttpResponse,
  HttpResponseError,
  isHttpServerErrorJsonParseFailure,
  isHttpServerErrorStatus,
} from "./handled-failure.ts";

describe("HttpResponseError", () => {
  it("exposes the response status on a typed Error subclass", () => {
    const error = new HttpResponseError("Server unavailable", 503);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HttpResponseError);
    expect(error.message).toBe("Server unavailable");
    expect(error.status).toBe(503);
    expect(error.name).toBe("HttpResponseError");
  });
});

describe("isHttpServerErrorStatus", () => {
  it.each([500, 502, 599])("accepts %i", (status) => {
    expect(isHttpServerErrorStatus(status)).toBe(true);
  });

  it.each([499, 400, 200, 600])("rejects %i", (status) => {
    expect(isHttpServerErrorStatus(status)).toBe(false);
  });
});

describe("isHttpServerErrorJsonParseFailure", () => {
  it("recognizes a SyntaxError on an observed 5xx", () => {
    expect(isHttpServerErrorJsonParseFailure(new SyntaxError("Unexpected token"), 502)).toBe(true);
  });

  it.each([
    [new SyntaxError("Unexpected token"), 200],
    [new SyntaxError("Unexpected token"), 404],
    [new TypeError("Body already consumed"), 502],
    [new Error("read failed"), 500],
    ["not an error", 503],
  ])("rejects %#", (error, status) => {
    expect(isHttpServerErrorJsonParseFailure(error, status)).toBe(false);
  });
});

describe("guardTrpcHttpResponse", () => {
  it("passes non-5xx responses through without reading the body", async () => {
    const response = new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const clone = vi.spyOn(response, "clone");
    await expect(guardTrpcHttpResponse(response)).resolves.toBe(response);
    expect(clone).not.toHaveBeenCalled();
  });

  it("throws a typed HTTP failure for an HTML 502", async () => {
    const response = new Response("<html>Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
    await expect(guardTrpcHttpResponse(response)).rejects.toEqual(
      expect.objectContaining({
        name: "HttpResponseError",
        status: 502,
        message: expect.stringContaining("502"),
      }),
    );
  });

  it.each([
    ['{"message":"upstream failed"}', "generic JSON"],
    ["{not-json", "malformed JSON"],
  ])("throws a typed HTTP failure for %s 5xx bodies", async (body) => {
    const response = new Response(body, {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    await expect(guardTrpcHttpResponse(response)).rejects.toMatchObject({
      name: "HttpResponseError",
      status: 503,
    });
  });

  it("returns the original response for a structured tRPC error envelope with body intact", async () => {
    const envelope = {
      error: {
        code: -32603,
        message: "INTERNAL_SERVER_ERROR",
        data: { code: "INTERNAL_SERVER_ERROR" },
      },
    };
    const response = new Response(JSON.stringify(envelope), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await expect(guardTrpcHttpResponse(response)).resolves.toBe(response);
    await expect(response.json()).resolves.toEqual(envelope);
  });

  it("returns the original response for a nonempty batched tRPC error array", async () => {
    const envelopes = [
      { error: { code: -32600, message: "BAD_REQUEST" } },
      { error: { code: -32603, message: "INTERNAL_SERVER_ERROR" } },
    ];
    const response = new Response(JSON.stringify(envelopes), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await expect(guardTrpcHttpResponse(response)).resolves.toBe(response);
    await expect(response.json()).resolves.toEqual(envelopes);
  });

  it("throws when clone or decode of an observed 5xx JSON body fails", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
    vi.spyOn(response, "clone").mockImplementation(() => {
      throw new Error("clone failed");
    });
    await expect(guardTrpcHttpResponse(response)).rejects.toMatchObject({
      name: "HttpResponseError",
      status: 502,
    });
  });

  it("retains non-5xx parse handling for callers by not inspecting the body", async () => {
    const response = new Response("{broken", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(guardTrpcHttpResponse(response)).resolves.toBe(response);
    await expect(response.json()).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("classifyHandledFailure", () => {
  it.each([500, 599])("classifies a typed HTTP %s response as http_5xx", (status) => {
    expect(classifyHandledFailure(new HttpResponseError(`HTTP ${status}`, status))).toBe(
      "http_5xx",
    );
  });

  it("classifies a wrapped typed HTTP 5xx through its innermost cause", () => {
    expect(
      classifyHandledFailure(
        new Error("Request failed", { cause: new HttpResponseError("Bad gateway", 502) }),
      ),
    ).toBe("http_5xx");
  });

  it.each([400, 404, 499, 600])("retains a typed HTTP %s response as reportable", (status) => {
    expect(classifyHandledFailure(new HttpResponseError(`HTTP ${status}`, status))).toBeNull();
  });

  it.each([
    new Error("HTTP 500"),
    new Error("HTTP 503"),
    Object.assign(new Error("upload failed"), { status: 500 }),
    { status: 502, message: "Bad gateway" },
    new Error("Part 1 upload failed (HTTP 500)"),
  ])("does not guess http_5xx from message or status metadata %#", (error) => {
    expect(classifyHandledFailure(error)).toBeNull();
  });

  it("keeps an unexpected underlying cause reportable under an HTTP 5xx wrapper", () => {
    const error = new HttpResponseError("Bad gateway", 502);
    error.cause = new Error("Failed to write value.");
    expect(classifyHandledFailure(error)).toBeNull();
  });

  it("does not hide a parse failure behind an HTTP 5xx cause", () => {
    expect(
      classifyHandledFailure(
        new SyntaxError("Invalid JSON", { cause: new HttpResponseError("Bad gateway", 502) }),
      ),
    ).toBeNull();
  });

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

  it("preserves an explicit credential outcome over auth transport text", () => {
    const error = Object.assign(new Error("fetch failed: The network connection was lost."), {
      data: { handledFailure: "invalid_credentials" },
    });
    expect(classifyHandledFailure(error, "auth-state-restore")).toBe("invalid_credentials");
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

  const nativeWhoopTimeout = () =>
    Object.assign(new Error("Connection timed out"), { code: "TIMEOUT" });

  it.each(["whoop-ble-init-sync", "whoop-ble-foreground-sync"])(
    "classifies the native WHOOP BLE connection timeout under %s",
    (source) => {
      expect(classifyHandledFailure(nativeWhoopTimeout(), source)).toBe("bluetooth_timeout");
      expect(
        classifyHandledFailure(new Error("connect", { cause: nativeWhoopTimeout() }), source),
      ).toBe("bluetooth_timeout");
    },
  );

  it.each([undefined, "react-query", "whoop-ble-start-streaming", "whoop-ble-native-capture"])(
    "retains the WHOOP timeout outside the approved connection sources (%s)",
    (source) => {
      expect(classifyHandledFailure(nativeWhoopTimeout(), source)).toBeNull();
    },
  );

  it.each([
    ["message only", new Error("Connection timed out")],
    [
      "a different native code",
      Object.assign(new Error("Connection timed out"), { code: "DISCONNECTED" }),
    ],
    ["a non-Error object", { code: "TIMEOUT", message: "Connection timed out" }],
  ])("retains the %s without a typed native TIMEOUT Error", (_label, error) => {
    expect(classifyHandledFailure(error, "whoop-ble-init-sync")).toBeNull();
  });

  it("keeps an unexpected underlying cause reportable under a WHOOP timeout", () => {
    expect(
      classifyHandledFailure(
        Object.assign(new Error("Connection timed out"), {
          code: "TIMEOUT",
          cause: new Error("Failed to write value."),
        }),
        "whoop-ble-init-sync",
      ),
    ).toBeNull();
  });

  it.each([
    [new SyntaxError("Connection timed out", { cause: nativeWhoopTimeout() }), null],
    [
      Object.assign(nativeWhoopTimeout(), { data: { handledFailure: "invalid_credentials" } }),
      "invalid_credentials",
    ],
  ])(
    "respects existing leaf and credential protections under a WHOOP timeout (%#)",
    (error, expected) => {
      expect(classifyHandledFailure(error, "whoop-ble-init-sync")).toBe(expected);
    },
  );
});

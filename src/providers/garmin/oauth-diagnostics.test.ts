import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderConnectionError } from "../auth-errors.ts";

const { captureException, warn } = vi.hoisted(() => ({
  captureException: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../lib/error-reporting.ts", () => ({ captureException }));
vi.mock("../../logger.ts", () => ({ logger: { warn } }));
let reportGarminConnectionHttpFailure: typeof import("./oauth-diagnostics.ts").reportGarminConnectionHttpFailure;

describe("Garmin OAuth failure diagnostics", () => {
  const denied = () => new ProviderConnectionError("Garmin Connect", "permissions", 403);
  beforeEach(async () => {
    vi.resetModules();
    ({ reportGarminConnectionHttpFailure } = await import("./oauth-diagnostics.ts"));
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  function diagnostic() {
    const [, context] = vi.mocked(captureException).mock.calls.at(-1) ?? [];
    return context && typeof context === "object" && "extra" in context ? context.extra : undefined;
  }

  it("records known denial codes, response shape and validated support references", async () => {
    const error = denied();
    const response = Response.json(
      {
        error: "insufficient_scope",
        error_description: "synthetic-sensitive-description",
        userId: "synthetic-account-id",
      },
      {
        status: 403,
        headers: {
          "x-request-id": "123e4567-e89b-42d3-a456-426614174000",
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      },
    );
    await reportGarminConnectionHttpFailure(response, error);
    expect(diagnostic()).toEqual({
      event: "connection_http_failed",
      providerId: "garmin",
      stage: "permissions",
      statusCode: 403,
      contentType: "application/json",
      bodyKind: "json_object",
      bodyFields: ["error", "error_description"],
      errorCodes: ["insufficient_scope"],
      requestIds: {
        "x-request-id": "123e4567-e89b-42d3-a456-426614174000",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });
    expect(captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: { provider: "garmin", operation: "oauth-connection", stage: "permissions" },
        level: "warning",
      }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"stage":"permissions"'));
    expect(await response.json()).toHaveProperty("userId", "synthetic-account-id");
    expect(error).toMatchObject({ stage: "permissions", statusCode: 403 });
  });

  it("never emits raw bodies, descriptions, account fields, credential headers or arbitrary request IDs", async () => {
    const secret = "synthetic-private-token";
    const response = Response.json(
      {
        error: secret,
        code: secret,
        errorCode: secret,
        errorMessage: secret,
        message: secret,
        access_token: secret,
        refresh_token: secret,
        userId: secret,
        [secret]: secret,
      },
      {
        status: 403,
        statusText: secret,
        headers: {
          Authorization: `Bearer ${secret}`,
          "Set-Cookie": secret,
          Location: `https://example.com/?token=${secret}`,
          "x-request-id": secret,
          "x-correlation-id": `https://example.com/${secret}`,
          "request-id": `Bearer ${secret}`,
          traceparent: secret,
          "Content-Type": `application/json; detail=${secret}`,
        },
      },
    );
    await reportGarminConnectionHttpFailure(response, denied());
    expect(diagnostic()).toMatchObject({
      bodyKind: "json_object",
      errorCodes: [],
      requestIds: {},
      contentType: "application/json",
    });
    const output =
      JSON.stringify([warn.mock.calls, vi.mocked(captureException).mock.calls]) +
      vi
        .mocked(captureException)
        .mock.calls.map(([error]) => String(error))
        .join();
    expect(output).not.toContain(secret);
    expect(output).not.toContain("example.com");
  });

  it.each([
    { type: "application/json", body: "", kind: "empty" },
    { type: "application/json", body: "not json", kind: "invalid_json" },
    { type: "application/json", body: '["synthetic-secret"]', kind: "json_array" },
    { type: "application/json", body: '"synthetic-secret"', kind: "json_scalar" },
    { type: "application/json", body: "null", kind: "json_scalar" },
    { type: "text/html", body: "<html>synthetic-secret</html>", kind: "html" },
    { type: "text/plain", body: "synthetic-secret", kind: "text" },
    { type: "application/problem+json", body: '{"code":"access_denied"}', kind: "json_object" },
    { type: "application/x-synthetic-secret", body: "synthetic-secret", kind: "text" },
    { type: " Application/JSON ; charset=UTF-8", body: "  \n\t", kind: "empty" },
  ])("reports $kind without retaining body content", async ({ type, body, kind }) => {
    await reportGarminConnectionHttpFailure(
      new Response(body, { status: 403, headers: { "Content-Type": type } }),
      denied(),
    );
    expect(diagnostic()).toHaveProperty("bodyKind", kind);
    expect(JSON.stringify([warn.mock.calls, vi.mocked(captureException).mock.calls])).not.toContain(
      "synthetic-secret",
    );
  });

  it("normalizes media types and omits arbitrary types from diagnostics", async () => {
    await reportGarminConnectionHttpFailure(
      new Response("private", {
        status: 403,
        headers: { "content-type": " Text/PLAIN ; charset=utf-8" },
      }),
      denied(),
    );
    expect(diagnostic()).toHaveProperty("contentType", "text/plain");
    await reportGarminConnectionHttpFailure(
      new Response("private", { status: 403, headers: { "content-type": "application/private" } }),
      denied(),
    );
    expect(diagnostic()).toHaveProperty("contentType", "unknown");
  });

  it("reports a missing body without attempting to read a stream", async () => {
    await reportGarminConnectionHttpFailure(new Response(null, { status: 403 }), denied());
    expect(diagnostic()).toHaveProperty("bodyKind", "empty");
  });

  it("recognizes known structured error codes without copying unknown fields", async () => {
    await reportGarminConnectionHttpFailure(
      Response.json(
        {
          errorCode: "invalid_token",
          errors: [
            { code: "access_denied", message: "synthetic-secret" },
            { code: "invalid_token" },
            { code: "synthetic-secret" },
          ],
        },
        { status: 401 },
      ),
      new ProviderConnectionError("Garmin Connect", "identity", 401),
    );
    expect(diagnostic()).toMatchObject({
      stage: "identity",
      statusCode: 401,
      errorCodes: ["invalid_token", "access_denied"],
    });
  });

  it.each([
    "00000000-0000-0000-0000-000000000000",
    "token-shaped-opaque-id",
    "123e4567-e89b-42d3-a456-426614174000-extra",
    "prefix-123e4567-e89b-42d3-a456-426614174000",
  ])("rejects unapproved request identifier %s", async (value) => {
    await reportGarminConnectionHttpFailure(
      new Response(null, { status: 403, headers: { "x-request-id": value } }),
      denied(),
    );
    expect(diagnostic()).toHaveProperty("requestIds", {});
  });

  it("accepts only canonical nonzero W3C trace identifiers", async () => {
    await reportGarminConnectionHttpFailure(
      new Response(null, {
        status: 403,
        headers: {
          traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
          "request-id": "123e4567-e89b-42d3-a456-426614174000",
          "x-correlation-id": "123e4567-e89b-42d3-a456-426614174001",
        },
      }),
      denied(),
    );
    expect(diagnostic()).toHaveProperty("requestIds", {
      "request-id": "123e4567-e89b-42d3-a456-426614174000",
      "x-correlation-id": "123e4567-e89b-42d3-a456-426614174001",
    });
  });

  it.each([
    "prefix-00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-suffix",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
  ])("rejects invalid trace references %s", async (value) => {
    await reportGarminConnectionHttpFailure(
      new Response(null, { status: 403, headers: { traceparent: value } }),
      denied(),
    );
    expect(diagnostic()).toHaveProperty("requestIds", {});
  });

  it("decodes UTF-8 response bytes across chunk boundaries and releases the reader", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([239]));
        controller.enqueue(new Uint8Array([187]));
        controller.enqueue(new Uint8Array([191]));
        controller.enqueue(new TextEncoder().encode('{"error":"access_denied"}'));
        controller.close();
      },
    });
    const response = new Response(stream, {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    const clone = response.clone();
    vi.spyOn(response, "clone").mockReturnValue(clone);
    await reportGarminConnectionHttpFailure(response, denied());
    expect(diagnostic()).toHaveProperty("errorCodes", ["access_denied"]);
    expect(clone.body?.locked).toBe(false);
  });

  it("bounds response inspection and reports oversized bodies without waiting for the remainder", async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode("x".repeat(8193)));
        }
      },
    });
    await reportGarminConnectionHttpFailure(new Response(stream, { status: 403 }), denied());
    expect(diagnostic()).toHaveProperty("bodyKind", "too_large");
  });

  it("inspects a body exactly at the byte limit", async () => {
    await reportGarminConnectionHttpFailure(
      new Response("x".repeat(8192), { status: 403 }),
      denied(),
    );
    expect(diagnostic()).toHaveProperty("bodyKind", "text");
  });

  it("counts bytes across chunks before inspecting JSON", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8191));
        controller.enqueue(new Uint8Array(2));
        controller.close();
      },
    });
    await reportGarminConnectionHttpFailure(
      new Response(stream, { status: 403, headers: { "content-type": "application/json" } }),
      denied(),
    );
    expect(diagnostic()).toHaveProperty("bodyKind", "too_large");
  });

  it("ignores non-object entries in upstream error lists", async () => {
    await reportGarminConnectionHttpFailure(
      Response.json({ errors: [null, "private-detail", { code: "forbidden" }] }, { status: 403 }),
      denied(),
    );
    expect(diagnostic()).toHaveProperty("errorCodes", ["forbidden"]);
  });

  it("reports unreadable responses without exposing stream errors or replacing the denial", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("synthetic-private-stream-error"));
      },
    });
    const error = denied();
    await expect(
      reportGarminConnectionHttpFailure(new Response(stream, { status: 403 }), error),
    ).resolves.toBeUndefined();
    expect(diagnostic()).toHaveProperty("bodyKind", "unreadable");
    expect(vi.mocked(captureException).mock.calls.some(([captured]) => captured === error)).toBe(
      true,
    );
    for (const operation of ["read", "cancel"]) {
      expect(captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            operation === "read"
              ? "Unable to read Garmin connection diagnostic response"
              : "Unable to cancel Garmin connection diagnostic reader",
        }),
        { tags: { provider: "garmin", operation: "oauth-connection-diagnostics" } },
      );
    }
    expect(
      vi
        .mocked(captureException)
        .mock.calls.map(([captured]) => String(captured))
        .join(),
    ).not.toContain("synthetic-private-stream-error");
  });
});

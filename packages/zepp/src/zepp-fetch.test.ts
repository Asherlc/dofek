import { describe, expect, it, vi } from "vitest";
import {
  handleDofekUploadFailure,
  requireSecureDofekServerUrl,
  summarizeZeppFetchResponse,
} from "./zepp-fetch.ts";

describe("requireSecureDofekServerUrl", () => {
  it("accepts HTTPS and rejects cleartext or malformed server URLs", () => {
    expect(requireSecureDofekServerUrl(" https://dofek.example/path/ ")).toBe(
      "https://dofek.example/path",
    );
    expect(() => requireSecureDofekServerUrl("http://dofek.example")).toThrow(
      "Dofek server URL must use HTTPS.",
    );
    expect(() => requireSecureDofekServerUrl("not-a-url")).toThrow(
      "Dofek server URL must use HTTPS.",
    );
    expect(() => requireSecureDofekServerUrl("https://dofek.example:invalid-port")).toThrow(
      "Dofek server URL must use HTTPS.",
    );
    expect(() => requireSecureDofekServerUrl("https://dofek.example:65536")).toThrow(
      "Dofek server URL must use HTTPS.",
    );
    expect(() => requireSecureDofekServerUrl("https://dofek.example:0")).toThrow(
      "Dofek server URL must use HTTPS.",
    );
    expect(requireSecureDofekServerUrl("https://dofek.example:1///")).toBe(
      "https://dofek.example:1",
    );
    expect(requireSecureDofekServerUrl("https://dofek.example:65535/path")).toBe(
      "https://dofek.example:65535/path",
    );
    expect(requireSecureDofekServerUrl("https://dofek.example:8443")).toBe(
      "https://dofek.example:8443",
    );
  });

  it.each([
    "prefix-https://dofek.example",
    "https://user@dofek.example",
    "https://dofek.example:443 suffix",
    "https://dofek.example:",
    "https://[not-ipv6]",
  ])("rejects malformed authority %s", (value) => {
    expect(() => requireSecureDofekServerUrl(value)).toThrow("Dofek server URL must use HTTPS.");
  });
});

describe("summarizeZeppFetchResponse", () => {
  it("accepts a successful JSON-string body", () => {
    expect(summarizeZeppFetchResponse({ status: 200, body: '{"status":"ok"}' })).toEqual({
      body: { status: "ok" },
      errorMessage: null,
      ok: true,
      status: 200,
    });
  });

  it("uses statusCode when status is absent", () => {
    expect(summarizeZeppFetchResponse({ statusCode: 204 })).toEqual({
      body: undefined,
      errorMessage: null,
      ok: true,
      status: 204,
    });
  });

  it("extracts JSON-string error bodies for failed responses", () => {
    expect(
      summarizeZeppFetchResponse({
        status: 401,
        body: '{"error":"Invalid or revoked Dofek connection."}',
      }),
    ).toMatchObject({
      errorMessage: "Invalid or revoked Dofek connection.",
      ok: false,
      status: 401,
    });
  });

  it("includes structured validation field paths in failed responses", () => {
    expect(
      summarizeZeppFetchResponse({
        status: 400,
        body: {
          error: "Invalid payload",
          details: {
            formErrors: [],
            fieldErrors: {
              restingHeartRate: ["Expected number"],
              backgroundSamples: ["Invalid input"],
            },
          },
        },
      }),
    ).toMatchObject({
      errorMessage:
        "Invalid payload: backgroundSamples: Invalid input; restingHeartRate: Expected number",
      ok: false,
      status: 400,
    });
  });

  it("treats redirects as failed responses", () => {
    expect(summarizeZeppFetchResponse({ status: 302 })).toMatchObject({
      errorMessage: "HTTP 302",
      ok: false,
      status: 302,
    });
  });

  it("treats an error body as failed even when Zepp omits the status", () => {
    expect(
      summarizeZeppFetchResponse({
        body: { error: "Dofek connection is required." },
      }),
    ).toEqual({
      body: { error: "Dofek connection is required." },
      errorMessage: "Dofek connection is required.",
      ok: false,
      status: null,
    });
  });

  it("falls back to the HTTP status when the body has no message", () => {
    expect(summarizeZeppFetchResponse({ status: 500, body: {} })).toMatchObject({
      errorMessage: "HTTP 500",
      ok: false,
      status: 500,
    });
  });

  it("extracts message and plain-text failures", () => {
    expect(
      summarizeZeppFetchResponse({ status: 400, body: { message: "  bad request  " } }),
    ).toMatchObject({
      errorMessage: "bad request",
      ok: false,
    });
    expect(summarizeZeppFetchResponse({ status: 503, body: "  unavailable  " })).toMatchObject({
      body: "  unavailable  ",
      errorMessage: "unavailable",
      ok: false,
    });
  });

  it.each([199, 300])("treats boundary status %s as failed", (status) => {
    expect(summarizeZeppFetchResponse({ status })).toEqual({
      body: undefined,
      errorMessage: `HTTP ${status}`,
      ok: false,
      status,
    });
  });

  it("prefers status over statusCode and preserves invalid JSON strings", () => {
    expect(summarizeZeppFetchResponse({ status: 201, statusCode: 500, body: "{" })).toEqual({
      body: "{",
      errorMessage: "{",
      ok: false,
      status: 201,
    });
  });
});

describe("handleDofekUploadFailure", () => {
  it("expires invalid credentials and returns the actionable server error for every upload path", () => {
    const values = new Map([["dofek_api_token", "expired-token"]]);
    const storage = {
      removeItem: vi.fn((key: string) => values.delete(key)),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const error = handleDofekUploadFailure(
      storage,
      {
        body: { error: "Invalid or revoked Dofek connection." },
        errorMessage: "Invalid or revoked Dofek connection.",
        ok: false,
        status: 401,
      },
      "Data upload failed.",
    );

    expect(error.message).toBe("Invalid or revoked Dofek connection.");
    expect(storage.removeItem).toHaveBeenCalledWith("dofek_api_token");
    expect(JSON.parse(values.get("dofek_connection_status") ?? "{}")).toEqual({
      state: "error",
      reason: "Dofek connection expired. Connect again.",
    });
  });

  it("keeps credentials for non-auth failures and uses the caller fallback", () => {
    const storage = { removeItem: vi.fn(), setItem: vi.fn() };

    const error = handleDofekUploadFailure(
      storage,
      { body: {}, errorMessage: null, ok: false, status: 500 },
      "Upload failed.",
    );

    expect(error.message).toBe("Upload failed.");
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

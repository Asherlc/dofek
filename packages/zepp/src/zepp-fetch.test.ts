import { describe, expect, it } from "vitest";
import { summarizeZeppFetchResponse } from "./zepp-fetch.ts";

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
});

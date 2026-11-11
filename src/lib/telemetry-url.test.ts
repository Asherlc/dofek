import { describe, expect, it } from "vitest";
import {
  redactTelemetryAttributes,
  redactTelemetryQuery,
  redactTelemetryUrl,
  telemetryHttpAttributes,
} from "./telemetry-url.ts";

describe("telemetry URL redaction", () => {
  it("redacts repeated and encoded credential names without removing nonsensitive fields", () => {
    const query = redactTelemetryQuery(
      "%74%6f%6b%65%6e=synthetic-one&token=synthetic-two&SESSION=synthetic-three&code=synthetic-four&feed=dailies",
    );
    expect(query).toBe("token=REDACTED&SESSION=REDACTED&code=REDACTED&feed=dailies");
  });

  it("retains the query prefix used by Undici and Sentry", () => {
    expect(redactTelemetryQuery("?token=synthetic&feed=fit")).toBe("?token=REDACTED&feed=fit");
  });

  it("preserves the SDK's signed-URL credential redaction", () => {
    expect(
      redactTelemetryQuery("X-Amz-Signature=synthetic&Signature=synthetic&sig=synthetic&feed=fit"),
    ).toBe("X-Amz-Signature=REDACTED&Signature=REDACTED&sig=REDACTED&feed=fit");
  });

  it("keeps ordinary URLs and their original query encoding unchanged", () => {
    expect(redactTelemetryUrl("https://example.test/file?feed=fit%20file&n=2")).toBe(
      "https://example.test/file?feed=fit%20file&n=2",
    );
    expect(redactTelemetryUrl("GET /health")).toBe("GET /health");
  });

  it("keeps fragment boundaries when redacting a URL query", () => {
    expect(redactTelemetryUrl("https://example.test/file?token=synthetic#section")).toBe(
      "https://example.test/file?token=REDACTED#section",
    );
  });

  it("generates safe full and legacy attributes for URLs without queries", () => {
    expect(telemetryHttpAttributes("https://example.test/file")).toEqual({
      "url.full": "https://example.test/file",
      "http.url": "https://example.test/file",
      "http.target": "/file",
      "url.query": "",
    });
  });

  it("redacts known URL attributes without changing unrelated data", () => {
    const attributes = {
      "url.full": "https://example.test/file?token=synthetic",
      "http.target": "/file?token=synthetic",
      "url.query": "token=synthetic",
      "http.query": "?token=synthetic",
      count: 3,
      label: "token=ordinary label",
    };
    redactTelemetryAttributes(attributes);
    expect(attributes).toEqual({
      "url.full": "https://example.test/file?token=REDACTED",
      "http.target": "/file?token=REDACTED",
      "url.query": "token=REDACTED",
      "http.query": "?token=REDACTED",
      count: 3,
      label: "token=ordinary label",
    });
    expect(() => redactTelemetryAttributes(undefined)).not.toThrow();
  });
});

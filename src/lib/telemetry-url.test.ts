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

  it("keeps geocoding credentials and lookup text out of outgoing URL and query attributes", () => {
    const url =
      "https://api.geoapify.com/v1/geocode/search?apiKey=synthetic&text=Place&format=json";
    expect(telemetryHttpAttributes(url)).toEqual({
      "url.full":
        "https://api.geoapify.com/v1/geocode/search?apiKey=REDACTED&text=REDACTED&format=json",
      "http.url":
        "https://api.geoapify.com/v1/geocode/search?apiKey=REDACTED&text=REDACTED&format=json",
      "http.target": "/v1/geocode/search?apiKey=REDACTED&text=REDACTED&format=json",
      "url.query": "apiKey=REDACTED&text=REDACTED&format=json",
    });
  });

  it("redacts ClickHouse location, cursor, and activity hydration parameters", () => {
    const query =
      "param_latitude=37.8&param_longitude=-122.3&param_cursorId=synthetic&param_cursorStartedAt=2026-03-15&param_activityIds=%5Bprivate-id%5D&param_limit=20";
    expect(redactTelemetryQuery(query)).toBe(
      "param_latitude=REDACTED&param_longitude=REDACTED&param_cursorId=REDACTED&param_cursorStartedAt=REDACTED&param_activityIds=REDACTED&param_limit=20",
    );
  });

  it("redacts serialized tRPC GET input while retaining the batch marker", () => {
    const url = "/api/trpc/activityLocation.search?batch=1&input=%7B%22name%22%3A%22Private%22%7D";
    expect(redactTelemetryUrl(url)).toBe(
      "/api/trpc/activityLocation.search?batch=1&input=REDACTED",
    );
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

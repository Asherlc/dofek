import { describe, expect, it } from "vitest";
import { providerHealth } from "./provider-health.ts";

describe("providerHealth", () => {
  it("keeps connection and authorization healthy states separate", () => {
    expect(
      providerHealth({
        authorized: true,
        needsReauth: false,
        requiresAuthorization: true,
      }),
    ).toEqual({
      connection: { label: "Connected", status: "healthy" },
      authorization: { label: "Active", status: "healthy" },
      requiresReconnect: false,
    });
  });

  it("marks a stored connection disconnected when reconnection is required", () => {
    expect(
      providerHealth({
        authorized: true,
        needsReauth: true,
        requiresAuthorization: true,
      }),
    ).toEqual({
      connection: { label: "Disconnected", status: "warning" },
      authorization: { label: "Reconnect required", status: "warning" },
      requiresReconnect: true,
    });
  });

  it("reports that a removed expired connection still requires reconnection", () => {
    expect(
      providerHealth({
        authorized: false,
        needsReauth: true,
        requiresAuthorization: true,
      }),
    ).toEqual({
      connection: { label: "Disconnected", status: "warning" },
      authorization: { label: "Reconnect required", status: "warning" },
      requiresReconnect: true,
    });
  });

  it("marks authorization as not required for connection-only sources", () => {
    expect(
      providerHealth({
        authorized: true,
        needsReauth: false,
        requiresAuthorization: false,
      }),
    ).toEqual({
      connection: { label: "Connected", status: "healthy" },
      authorization: { label: "Not required", status: "neutral" },
      requiresReconnect: false,
    });
  });
});

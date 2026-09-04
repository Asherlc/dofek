import { describe, expect, it } from "vitest";
import { deriveConnectionActions, parseConnectionState } from "./connection-state.ts";

describe("parseConnectionState", () => {
  it.each(["disconnected", "pairing", "checking", "connected", "disconnecting", "error"] as const)(
    "preserves %s",
    (state) => {
      expect(parseConnectionState(state)).toBe(state);
    },
  );

  it("migrates the former not-connected label", () => {
    expect(parseConnectionState("not connected")).toBe("disconnected");
  });

  it("fails closed for unknown states", () => {
    expect(parseConnectionState("connecting")).toBe("disconnected");
    expect(parseConnectionState(undefined)).toBe("disconnected");
  });
});

describe("deriveConnectionActions", () => {
  it("offers connection methods only while disconnected", () => {
    expect(deriveConnectionActions("disconnected", false)).toEqual({
      showConnectionForm: true,
      showPairing: true,
      showLogin: true,
      showCheck: false,
      showSync: false,
      showDisconnect: false,
    });
  });

  it("allows an in-progress pairing to be disconnected", () => {
    expect(deriveConnectionActions("pairing", false)).toEqual({
      showConnectionForm: false,
      showPairing: false,
      showLogin: false,
      showCheck: false,
      showSync: false,
      showDisconnect: true,
    });
  });

  it("shows management actions only for a verified connection", () => {
    expect(deriveConnectionActions("connected", true)).toEqual({
      showConnectionForm: false,
      showPairing: false,
      showLogin: false,
      showCheck: true,
      showSync: true,
      showDisconnect: true,
    });
  });

  it("does not trust a connected label when credentials are absent", () => {
    expect(deriveConnectionActions("connected", false)).toEqual({
      showConnectionForm: true,
      showPairing: true,
      showLogin: true,
      showCheck: false,
      showSync: false,
      showDisconnect: false,
    });
  });

  it("requires disconnect before reconnecting after an error with a token", () => {
    expect(deriveConnectionActions("error", true)).toEqual({
      showConnectionForm: false,
      showPairing: false,
      showLogin: false,
      showCheck: true,
      showSync: false,
      showDisconnect: true,
    });
  });

  it("allows reconnection after an error removed the invalid token", () => {
    expect(deriveConnectionActions("error", false)).toEqual({
      showConnectionForm: true,
      showPairing: true,
      showLogin: true,
      showCheck: false,
      showSync: false,
      showDisconnect: false,
    });
  });

  it.each([
    ["checking", true],
    ["disconnecting", true],
  ] as const)("does not expose conflicting actions while %s", (state, hasToken) => {
    expect(deriveConnectionActions(state, hasToken)).toMatchObject({
      showConnectionForm: false,
      showPairing: false,
      showLogin: false,
      showCheck: false,
      showSync: false,
      showDisconnect: state === "checking",
    });
  });
});

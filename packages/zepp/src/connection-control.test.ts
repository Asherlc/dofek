import { describe, expect, it } from "vitest";
import { createConnectionChangedCall, isConnectionChangedCall } from "./connection-control.ts";

describe("Zepp connection control", () => {
  it("creates a connection-change call that the watch recognizes", () => {
    const call = createConnectionChangedCall();
    expect(call).toEqual({ method: "dofek.connectionChanged", params: {} });
    expect(isConnectionChangedCall(call)).toBe(true);
  });

  it("does not treat unrelated or malformed messages as connection changes", () => {
    expect(isConnectionChangedCall(null)).toBe(false);
    expect(isConnectionChangedCall({ method: "health.collect" })).toBe(false);
    expect(isConnectionChangedCall({ method: 42 })).toBe(false);
    expect(isConnectionChangedCall({ method: "dofek.connectionChanged" })).toBe(false);
    expect(isConnectionChangedCall({ method: "dofek.connectionChanged", params: "invalid" })).toBe(
      false,
    );
    expect(
      isConnectionChangedCall({ method: "dofek.connectionChanged", params: { unexpected: true } }),
    ).toBe(false);
  });
});

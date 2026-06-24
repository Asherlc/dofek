import { describe, expect, it } from "vitest";
import {
  isPushProvider,
  PUSH_PROVIDERS,
  WHOOP_BLE_PROVIDER_ID,
} from "./push-providers.ts";

describe("push-providers", () => {
  it("defines WHOOP BLE as a mobile push provider", () => {
    expect(WHOOP_BLE_PROVIDER_ID).toBe("whoop_ble");
    expect(PUSH_PROVIDERS).toEqual([
      {
        id: "whoop_ble",
        name: "WHOOP (Bluetooth)",
        authType: "push:mobile",
        description: "Synced from the iOS app when your WHOOP strap is nearby.",
      },
    ]);
  });

  it("recognizes push provider IDs", () => {
    expect(isPushProvider("whoop_ble")).toBe(true);
    expect(isPushProvider("whoop")).toBe(false);
  });
});

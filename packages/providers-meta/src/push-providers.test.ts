import { describe, expect, it } from "vitest";
import {
  BLE_HEART_RATE_PROVIDER_ID,
  isPushProvider,
  PUSH_PROVIDERS,
  WHOOP_BLE_PROVIDER_ID,
} from "./push-providers.ts";

describe("push-providers", () => {
  it("defines WHOOP BLE as a mobile push provider", () => {
    expect(WHOOP_BLE_PROVIDER_ID).toBe("whoop_ble");
    expect(PUSH_PROVIDERS).toContainEqual({
      id: "whoop_ble",
      name: "WHOOP (Bluetooth)",
      authType: "push:mobile",
      description: "Synced from the iOS app when your WHOOP strap is nearby.",
    });
  });

  it("defines a generic Bluetooth heart-rate monitor as a mobile push provider", () => {
    expect(BLE_HEART_RATE_PROVIDER_ID).toBe("ble_heart_rate");
    expect(PUSH_PROVIDERS).toContainEqual({
      id: "ble_heart_rate",
      name: "Heart Rate Monitor (Bluetooth)",
      authType: "push:mobile",
      description: "Synced from the iOS app when a Bluetooth heart-rate monitor is connected.",
    });
  });

  it("recognizes push provider IDs", () => {
    expect(isPushProvider("whoop_ble")).toBe(true);
    expect(isPushProvider("ble_heart_rate")).toBe(true);
    expect(isPushProvider("whoop")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isUnsupportedWhoopDevice } from "./whoop-ble-errors";

describe("isUnsupportedWhoopDevice", () => {
  it("matches only the typed WHOOP NO_SERVICE rejection", () => {
    expect(isUnsupportedWhoopDevice({ code: "NO_SERVICE" })).toBe(true);
    expect(
      isUnsupportedWhoopDevice(
        Object.assign(new Error("WHOOP service not found"), { code: "NO_SERVICE" }),
      ),
    ).toBe(true);
    expect(isUnsupportedWhoopDevice({ code: "NO_CHARACTERISTICS" })).toBe(false);
    expect(isUnsupportedWhoopDevice({ code: "TIMEOUT" })).toBe(false);
    expect(isUnsupportedWhoopDevice(new Error("WHOOP service not found"))).toBe(false);
    expect(isUnsupportedWhoopDevice(null)).toBe(false);
  });
});

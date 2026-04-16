import { describe, expect, it } from "vitest";

const {
  mergeHealthKitEntitlements,
} = require("./with-healthkit-entitlements");

describe("withHealthKitEntitlements", () => {
  it("adds missing HealthKit entitlements", () => {
    const result = mergeHealthKitEntitlements({});
    expect(result["com.apple.developer.healthkit"]).toBe(true);
    expect(result["com.apple.developer.healthkit.background-delivery"]).toBe(true);
    expect(result["com.apple.developer.healthkit.access"]).toBe(true);
  });

  it("preserves unrelated entitlements", () => {
    const result = mergeHealthKitEntitlements({
      "aps-environment": "production",
    });
    expect(result["aps-environment"]).toBe("production");
    expect(result["com.apple.developer.healthkit"]).toBe(true);
    expect(result["com.apple.developer.healthkit.background-delivery"]).toBe(true);
    expect(result["com.apple.developer.healthkit.access"]).toBe(true);
  });

  it("forces HealthKit entitlements on when previously disabled", () => {
    const result = mergeHealthKitEntitlements({
      "com.apple.developer.healthkit": false,
      "com.apple.developer.healthkit.background-delivery": false,
      "com.apple.developer.healthkit.access": false,
    });
    expect(result["com.apple.developer.healthkit"]).toBe(true);
    expect(result["com.apple.developer.healthkit.background-delivery"]).toBe(true);
    expect(result["com.apple.developer.healthkit.access"]).toBe(true);
  });

  it("handles non-object input defensively", () => {
    expect(mergeHealthKitEntitlements(undefined)["com.apple.developer.healthkit"]).toBe(true);
    expect(mergeHealthKitEntitlements(null)["com.apple.developer.healthkit"]).toBe(true);
    expect(mergeHealthKitEntitlements("invalid")["com.apple.developer.healthkit"]).toBe(true);
    expect(mergeHealthKitEntitlements([])["com.apple.developer.healthkit"]).toBe(true);
  });
});

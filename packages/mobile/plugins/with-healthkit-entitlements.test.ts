import { describe, expect, it } from "vitest";

const {
  mergeHealthKitEntitlements,
  VERIFY_ENTITLEMENT_SCRIPT,
} = require("./with-healthkit-entitlements");

describe("withHealthKitEntitlements", () => {
  it("build phase script checks for HealthKit entitlement", () => {
    expect(VERIFY_ENTITLEMENT_SCRIPT).toContain("com.apple.developer.healthkit");
    expect(VERIFY_ENTITLEMENT_SCRIPT).toContain(
      "com.apple.developer.healthkit.background-delivery",
    );
    expect(VERIFY_ENTITLEMENT_SCRIPT).toContain("com.apple.developer.healthkit.access");
    expect(VERIFY_ENTITLEMENT_SCRIPT).toContain("exit 1");
  });

  it("adds missing HealthKit entitlements", () => {
    const result = mergeHealthKitEntitlements({});
    expect(result["com.apple.developer.healthkit"]).toBe(true);
    expect(result["com.apple.developer.healthkit.background-delivery"]).toBe(true);
    expect(result["com.apple.developer.healthkit.access"]).toEqual(["health-records"]);
  });

  it("preserves unrelated entitlements", () => {
    const result = mergeHealthKitEntitlements({
      "aps-environment": "production",
    });
    expect(result["aps-environment"]).toBe("production");
    expect(result["com.apple.developer.healthkit"]).toBe(true);
    expect(result["com.apple.developer.healthkit.background-delivery"]).toBe(true);
    expect(result["com.apple.developer.healthkit.access"]).toEqual(["health-records"]);
  });

  it("forces HealthKit entitlements on when previously disabled", () => {
    const result = mergeHealthKitEntitlements({
      "com.apple.developer.healthkit": false,
      "com.apple.developer.healthkit.background-delivery": false,
      "com.apple.developer.healthkit.access": false,
    });
    expect(result["com.apple.developer.healthkit"]).toBe(true);
    expect(result["com.apple.developer.healthkit.background-delivery"]).toBe(true);
    expect(result["com.apple.developer.healthkit.access"]).toEqual(["health-records"]);
  });

  it("handles non-object input defensively", () => {
    expect(mergeHealthKitEntitlements(undefined)["com.apple.developer.healthkit"]).toBe(true);
    expect(mergeHealthKitEntitlements(null)["com.apple.developer.healthkit"]).toBe(true);
    expect(mergeHealthKitEntitlements("invalid")["com.apple.developer.healthkit"]).toBe(true);
    expect(mergeHealthKitEntitlements([])["com.apple.developer.healthkit"]).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  compareRepeatedEffortKeys,
  identityKey,
  normalizeIdentityValue,
  rankEquivalenceStrength,
  sourceActivityInstanceKey,
} from "./repeated-effort-identity.ts";

describe("repeated effort identity", () => {
  it("keeps provider workout instances separate from reusable workout identities", () => {
    expect(
      identityKey({
        kind: "provider_workout",
        namespace: "peloton",
        value: "class-123",
      }),
    ).toBe("provider_workout:peloton:class-123");
    expect(sourceActivityInstanceKey({ provider: "peloton", externalId: "workout-999" })).toBe(
      "provider_activity_instance:peloton:workout-999",
    );
    expect(sourceActivityInstanceKey({ provider: "peloton", externalId: "workout-999" })).not.toBe(
      identityKey({ kind: "provider_workout", namespace: "peloton", value: "workout-999" }),
    );
  });

  it("normalizes only whitespace and case for name evidence", () => {
    expect(normalizeIdentityValue("  FTP   Test ")).toBe("ftp test");
    expect(normalizeIdentityValue("Route/42 — A+B")).toBe("route/42 — a+b");
  });

  it("ranks exact above strong inferred above caller asserted above weak", () => {
    expect(rankEquivalenceStrength("exact", "strong_inferred")).toBeGreaterThan(0);
    expect(rankEquivalenceStrength("strong_inferred", "caller_asserted")).toBeGreaterThan(0);
    expect(rankEquivalenceStrength("caller_asserted", "weak_similarity")).toBeGreaterThan(0);
    expect(rankEquivalenceStrength("weak_similarity", "weak_similarity")).toBe(0);
  });

  it("compares reusable effort keys deterministically by their complete identity", () => {
    const classKey = { kind: "provider_workout" as const, namespace: "peloton", value: "class-1" };
    const sameClassKey = { ...classKey };
    const routeKey = { kind: "provider_route" as const, namespace: "strava", value: "route-1" };

    expect(compareRepeatedEffortKeys(classKey, sameClassKey)).toBe(0);
    expect(compareRepeatedEffortKeys(classKey, routeKey)).toBeGreaterThan(0);
    expect(compareRepeatedEffortKeys(routeKey, classKey)).toBeLessThan(0);
  });
});

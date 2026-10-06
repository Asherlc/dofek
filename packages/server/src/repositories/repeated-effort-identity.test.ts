import { describe, expect, it } from "vitest";
import { identityKey, rankEquivalenceStrength } from "./repeated-effort-identity.ts";
import type { RepeatedEffortKey } from "./repeated-effort-types.ts";

describe("repeated effort identity", () => {
  it("includes kind, provider namespace, and value in reusable workout identities", () => {
    expect(
      identityKey({
        kind: "provider_workout",
        namespace: "peloton",
        value: "class-123",
      }),
    ).toBe("provider_workout:peloton:class-123");
  });

  it("ranks exact above strong inferred above caller asserted above weak", () => {
    expect(rankEquivalenceStrength("exact", "strong_inferred")).toBeGreaterThan(0);
    expect(rankEquivalenceStrength("strong_inferred", "caller_asserted")).toBeGreaterThan(0);
    expect(rankEquivalenceStrength("caller_asserted", "weak_similarity")).toBeGreaterThan(0);
    expect(rankEquivalenceStrength("weak_similarity", "weak_similarity")).toBe(0);
  });

  it("preserves a nullable namespace in reusable activity-name keys", () => {
    const key: RepeatedEffortKey = {
      kind: "activity_name",
      namespace: null,
      value: "FTP Test",
    };

    expect(identityKey(key)).toBe("activity_name::FTP Test");
  });
});

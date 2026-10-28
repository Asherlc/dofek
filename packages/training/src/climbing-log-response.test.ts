import { describe, expect, it } from "vitest";
import { climbingResponseVersionSchema, toClimbingLogTraitsV1 } from "./climbing-log-response.ts";

describe("climbing response versions", () => {
  it("defaults callers without a version to the original contract", () => {
    expect(climbingResponseVersionSchema.parse(undefined)).toBe(1);
    expect(climbingResponseVersionSchema.parse(2)).toBe(2);
    expect(climbingResponseVersionSchema.parse(3)).toBe(3);
    expect(climbingResponseVersionSchema.safeParse(4).success).toBe(false);
  });

  it.each([
    [null, null],
    [["crimp"], "crimp"],
    [["sloper"], "sloper"],
    [["pinch"], "pinch"],
    [["pocket"], "pocket"],
    [["jug"], "jug"],
    [["crimp", "crimp"], "crimp"],
    [["crimp", "jug"], null],
    [["volume"], null],
    [["jam"], null],
    [["no_grips"], null],
    [["jug", "jam"], null],
  ] as const)("projects the complete grip set %j into the V1 scalar %s", (holds, expected) => {
    const result = toClimbingLogTraitsV1({
      holdTypes: holds === null ? null : [...holds],
      wallAngle: null,
    });
    expect(result).toEqual({ holdType: expected, wallAngle: null });
  });

  it("represents categorical angles as unknown to V1 instead of inventing measurements", () => {
    expect(toClimbingLogTraitsV1({ holdTypes: ["jug"], wallAngle: { category: "slab" } })).toEqual({
      holdType: "jug",
      wallAngle: null,
    });
  });

  it.each(["degrees", null] as const)("retains a recorded numeric angle with units %s", (unit) => {
    const angle = { value: 0, unit };
    expect(toClimbingLogTraitsV1({ holdTypes: null, wallAngle: angle })).toEqual({
      holdType: null,
      wallAngle: angle,
    });
  });
});

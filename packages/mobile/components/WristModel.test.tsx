import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OrientationEvent } from "../modules/whoop-ble";
import {
  computeFaceNormal,
  crossProduct,
  dotProduct,
  normalizeVec,
  rotateByQuaternion,
  WristModel,
} from "./WristModel";

const identityOrientation: OrientationEvent = {
  w: 1,
  x: 0,
  y: 0,
  z: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,
};

describe("WristModel", () => {
  it("renders without crashing at identity orientation", () => {
    const { container } = render(<WristModel orientation={identityOrientation} size={250} />);
    expect(container).toBeTruthy();
  });

  it("renders at a non-identity orientation without crashing", () => {
    const rotated: OrientationEvent = {
      w: Math.SQRT1_2,
      x: Math.SQRT1_2,
      y: 0,
      z: 0,
      roll: 90,
      pitch: 0,
      yaw: 0,
    };
    const { container } = render(<WristModel orientation={rotated} size={200} />);
    expect(container).toBeTruthy();
  });

  it("uses the default size when none is provided", () => {
    const { container } = render(<WristModel orientation={identityOrientation} />);
    expect(container).toBeTruthy();
  });
});

describe("crossProduct", () => {
  it("computes i × j = k", () => {
    const result = crossProduct([1, 0, 0], [0, 1, 0]);
    expect(result).toEqual([0, 0, 1]);
  });

  it("computes j × i = -k", () => {
    const result = crossProduct([0, 1, 0], [1, 0, 0]);
    expect(result).toEqual([0, 0, -1]);
  });

  it("returns zero for parallel vectors", () => {
    const result = crossProduct([2, 0, 0], [5, 0, 0]);
    expect(result).toEqual([0, 0, 0]);
  });

  it("computes j × k = i", () => {
    const result = crossProduct([0, 1, 0], [0, 0, 1]);
    expect(result).toEqual([1, 0, 0]);
  });
});

describe("dotProduct", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(dotProduct([1, 0, 0], [1, 0, 0])).toBe(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(dotProduct([1, 0, 0], [0, 1, 0])).toBe(0);
  });

  it("returns -1 for opposite unit vectors", () => {
    expect(dotProduct([1, 0, 0], [-1, 0, 0])).toBe(-1);
  });

  it("computes correctly for arbitrary vectors", () => {
    expect(dotProduct([2, 3, 4], [1, -1, 2])).toBe(2 * 1 + 3 * -1 + 4 * 2);
  });
});

describe("normalizeVec", () => {
  it("normalizes a vector along one axis", () => {
    const result = normalizeVec([3, 0, 0]);
    expect(result).toEqual([1, 0, 0]);
  });

  it("normalizes a vector with equal components", () => {
    const result = normalizeVec([1, 1, 1]);
    const expected = 1 / Math.sqrt(3);
    expect(result[0]).toBeCloseTo(expected);
    expect(result[1]).toBeCloseTo(expected);
    expect(result[2]).toBeCloseTo(expected);
  });

  it("returns zero vector for zero input", () => {
    expect(normalizeVec([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("produces a unit-length result", () => {
    const result = normalizeVec([3, 4, 5]);
    const length = Math.hypot(...result);
    expect(length).toBeCloseTo(1);
  });
});

describe("computeFaceNormal", () => {
  it("computes the normal of a triangle in the XY plane as +Z", () => {
    const result = computeFaceNormal([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(result[0]).toBeCloseTo(0);
    expect(result[1]).toBeCloseTo(0);
    expect(result[2]).toBeCloseTo(1);
  });

  it("computes the normal of a triangle in the XZ plane as -Y", () => {
    const result = computeFaceNormal([
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]);
    expect(result[0]).toBeCloseTo(0);
    expect(result[1]).toBeCloseTo(-1);
    expect(result[2]).toBeCloseTo(0);
  });

  it("returns a unit-length normal", () => {
    const result = computeFaceNormal([
      [0, 0, 0],
      [3, 1, 0],
      [0, 2, 1],
    ]);
    const length = Math.hypot(...result);
    expect(length).toBeCloseTo(1);
  });

  it("returns fallback for degenerate input", () => {
    expect(computeFaceNormal([])).toEqual([0, 0, 1]);
    expect(computeFaceNormal([[0, 0, 0]])).toEqual([0, 0, 1]);
  });
});

describe("rotateByQuaternion", () => {
  it("identity quaternion leaves vertex unchanged", () => {
    const vertex: [number, number, number] = [3, 4, 5];
    const result = rotateByQuaternion(vertex, identityOrientation);
    expect(result[0]).toBeCloseTo(3);
    expect(result[1]).toBeCloseTo(4);
    expect(result[2]).toBeCloseTo(5);
  });

  it("90° rotation around X axis maps Y to Z", () => {
    const ninetyDegreesAroundX: OrientationEvent = {
      w: Math.SQRT1_2,
      x: Math.SQRT1_2,
      y: 0,
      z: 0,
      roll: 90,
      pitch: 0,
      yaw: 0,
    };
    const result = rotateByQuaternion([0, 1, 0], ninetyDegreesAroundX);
    expect(result[0]).toBeCloseTo(0);
    expect(result[1]).toBeCloseTo(0);
    expect(result[2]).toBeCloseTo(1);
  });

  it("90° rotation around Z axis maps X to Y", () => {
    const ninetyDegreesAroundZ: OrientationEvent = {
      w: Math.SQRT1_2,
      x: 0,
      y: 0,
      z: Math.SQRT1_2,
      roll: 0,
      pitch: 0,
      yaw: 90,
    };
    const result = rotateByQuaternion([1, 0, 0], ninetyDegreesAroundZ);
    expect(result[0]).toBeCloseTo(0);
    expect(result[1]).toBeCloseTo(1);
    expect(result[2]).toBeCloseTo(0);
  });

  it("180° rotation around Y axis negates X and Z", () => {
    const oneEightyAroundY: OrientationEvent = {
      w: 0,
      x: 0,
      y: 1,
      z: 0,
      roll: 0,
      pitch: 180,
      yaw: 0,
    };
    const result = rotateByQuaternion([1, 2, 3], oneEightyAroundY);
    expect(result[0]).toBeCloseTo(-1);
    expect(result[1]).toBeCloseTo(2);
    expect(result[2]).toBeCloseTo(-3);
  });
});

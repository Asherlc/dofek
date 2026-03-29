import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { WristModel } from "./WristModel";
import type { OrientationEvent } from "../modules/whoop-ble";

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
    const { container } = render(
      <WristModel orientation={identityOrientation} size={250} />,
    );
    expect(container).toBeTruthy();
  });

  it("renders at a non-identity orientation without crashing", () => {
    const rotated: OrientationEvent = {
      w: 0.707,
      x: 0.707,
      y: 0,
      z: 0,
      roll: 90,
      pitch: 0,
      yaw: 0,
    };
    const { container } = render(
      <WristModel orientation={rotated} size={200} />,
    );
    expect(container).toBeTruthy();
  });

  it("uses the default size when none is provided", () => {
    const { container } = render(
      <WristModel orientation={identityOrientation} />,
    );
    expect(container).toBeTruthy();
  });
});

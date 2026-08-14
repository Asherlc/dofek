import { describe, expect, it } from "vitest";
import { createRoundLoginLayout } from "./round-layout.ts";

const ROUND_DEVICE_WIDTHS = [480, 466, 454, 416, 360] as const;

function zeppPxForWidth(deviceWidth: number): (value: number) => number {
  return (value) => Math.ceil((value * deviceWidth) / 480);
}

describe("createRoundLoginLayout", () => {
  it("uses the approved circle-safe 480px reference geometry", () => {
    expect(createRoundLoginLayout(zeppPxForWidth(480), 480)).toEqual({
      hint: { x: 40, y: 310, w: 400, h: 72 },
      button: { x: 102, y: 386, w: 276, h: 44, radius: 22 },
    });
  });

  it.each(
    ROUND_DEVICE_WIDTHS,
  )("keeps the login action inside the %ipx round framebuffer and safe circle", (deviceWidth) => {
    const { button, hint } = createRoundLoginLayout(zeppPxForWidth(deviceWidth), deviceWidth);
    const buttonCorners: [number, number][] = [
      [button.x, button.y],
      [button.x + button.w, button.y],
      [button.x, button.y + button.h],
      [button.x + button.w, button.y + button.h],
    ];
    const center = deviceWidth / 2;
    const safeRadius = center - 2;

    expect(button.x).toBeGreaterThanOrEqual(0);
    expect(button.y).toBeGreaterThanOrEqual(0);
    expect(button.x + button.w).toBeLessThanOrEqual(deviceWidth);
    expect(button.y + button.h).toBeLessThanOrEqual(deviceWidth);
    expect(button.radius).toBe(Math.ceil(button.h / 2));
    expect(hint.x).toBeGreaterThanOrEqual(0);
    expect(hint.y).toBeGreaterThanOrEqual(0);
    expect(hint.x + hint.w).toBeLessThanOrEqual(deviceWidth);
    expect(hint.y + hint.h).toBeLessThanOrEqual(deviceWidth);
    expect(hint.y + hint.h).toBeLessThanOrEqual(button.y);

    for (const [x, y] of buttonCorners) {
      expect(Math.hypot(x - center, y - center)).toBeLessThanOrEqual(safeRadius);
    }
  });
});

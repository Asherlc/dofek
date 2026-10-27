import { describe, expect, it, vi } from "vitest";
import { captureViewportScreenshot, manifestOutputPath } from "./screenshot-output";

describe("captureViewportScreenshot", () => {
  it("captures the configured viewport without a device-scaled CSS clip", async () => {
    const screenshot = vi.fn(async () => Buffer.from([]));

    await captureViewportScreenshot({ screenshot }, "/tmp/shot.png");

    expect(screenshot).toHaveBeenCalledWith({ path: "/tmp/shot.png" });
  });
});

describe("manifestOutputPath", () => {
  it("returns a portable path relative to the mobile package", () => {
    expect(
      manifestOutputPath(
        "/workspace/packages/mobile",
        "/workspace/packages/mobile/app-store/screenshots/shot.png",
      ),
    ).toBe("app-store/screenshots/shot.png");
  });
});

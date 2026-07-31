// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const mockCapture = vi.fn();

vi.mock("posthog-js", () => ({
  default: {
    capture: mockCapture,
  },
}));

describe("web logger", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards structured logs to PostHog", async () => {
    const { logger } = await import("./logger.ts");
    logger.warn("upload", "retrying chunk", { attempt: 2 });

    expect(mockCapture).toHaveBeenCalledWith(
      "client_log",
      expect.objectContaining({
        level: "warn",
        category: "upload",
        message: "retrying chunk",
        platform: "web",
        attempt: 2,
      }),
    );
  });
});

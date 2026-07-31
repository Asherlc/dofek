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

  it("forwards info logs to PostHog", async () => {
    const { logger } = await import("./logger.ts");
    logger.info("auth", "signed in", { userId: "user-1" });

    expect(mockCapture).toHaveBeenCalledWith(
      "client_log",
      expect.objectContaining({
        level: "info",
        category: "auth",
        message: "signed in",
        platform: "web",
        userId: "user-1",
      }),
    );
  });

  it("forwards error logs to PostHog", async () => {
    const { logger } = await import("./logger.ts");
    logger.error("sync", "provider failed");

    expect(mockCapture).toHaveBeenCalledWith(
      "client_log",
      expect.objectContaining({
        level: "error",
        category: "sync",
        message: "provider failed",
        platform: "web",
      }),
    );
  });
});

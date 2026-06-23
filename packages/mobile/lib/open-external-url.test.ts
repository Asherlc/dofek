import { Linking } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./telemetry";

vi.mock("./telemetry", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

describe("openExternalUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the URL when Linking succeeds", async () => {
    vi.mocked(Linking.openURL).mockResolvedValue(undefined);

    const { openExternalUrl } = await import("./open-external-url");
    const opened = await openExternalUrl("https://www.fatsecret.com/", "food");

    expect(opened).toBe(true);
    expect(Linking.openURL).toHaveBeenCalledWith("https://www.fatsecret.com/");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a warning and returns false when Linking fails", async () => {
    vi.mocked(Linking.openURL).mockRejectedValue(
      new Error("Unable to open URL: https://www.fatsecret.com/"),
    );

    const { openExternalUrl } = await import("./open-external-url");
    const opened = await openExternalUrl("https://www.fatsecret.com/", "food");

    expect(opened).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("food", "Unable to open external URL", {
      url: "https://www.fatsecret.com/",
      message: "Unable to open URL: https://www.fatsecret.com/",
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { createSessionProgressHandler } from "./session-progress.ts";

describe("createSessionProgressHandler", () => {
  it("updates the watch and publishes each progress report to the host", () => {
    const updateWatch = vi.fn();
    const publishHostStatus = vi.fn();
    const handleProgress = createSessionProgressHandler({
      updateWatch,
      publishHostStatus,
    });
    const firstProgress = { sampleCount: 4_170, observedHzX100: 2_498 };
    const nextProgress = { sampleCount: 4_195, observedHzX100: 2_501 };

    handleProgress(firstProgress);
    handleProgress(nextProgress);

    expect(updateWatch).toHaveBeenNthCalledWith(1, firstProgress);
    expect(updateWatch).toHaveBeenNthCalledWith(2, nextProgress);
    expect(publishHostStatus).toHaveBeenNthCalledWith(1, firstProgress);
    expect(publishHostStatus).toHaveBeenNthCalledWith(2, nextProgress);
  });

  it("still publishes the progress report when the watch update fails", () => {
    const error = new Error("metadata write failed");
    const publishHostStatus = vi.fn();
    const handleProgress = createSessionProgressHandler({
      updateWatch: () => {
        throw error;
      },
      publishHostStatus,
    });
    const progress = { sampleCount: 4_170, observedHzX100: 2_498 };

    expect(() => handleProgress(progress)).toThrow(error);
    expect(publishHostStatus).toHaveBeenCalledWith(progress);
  });
});

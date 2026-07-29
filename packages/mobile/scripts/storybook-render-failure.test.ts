import { describe, expect, it } from "vitest";
import { assertStoryRendered } from "./storybook-render-failure";

type StorybookPage = Parameters<typeof assertStoryRendered>[0];

interface StorybookRenderFailure {
  message: string;
  stack: string | null;
}

function storybookPage({
  renderFailure,
  processingError,
}: {
  renderFailure?: StorybookRenderFailure;
  processingError?: string;
} = {}): StorybookPage {
  return {
    locator(selector) {
      const text = {
        "#error-message:visible": renderFailure?.message,
        "#error-stack:visible": renderFailure?.stack,
        'text="Processing status is unavailable"': processingError
          ? "Processing status is unavailable"
          : null,
        'text="Failed to fetch"': processingError ?? null,
      }[selector];
      return {
        count: async () => (text == null ? 0 : 1),
        textContent: async () => text ?? null,
      };
    },
  };
}

describe("assertStoryRendered", () => {
  it("allows a story without a visible Storybook render error", async () => {
    await expect(assertStoryRendered(storybookPage(), "pages-settings--default")).resolves.toBe(
      undefined,
    );
  });

  it("fails with the story id and first fatal line", async () => {
    const page = storybookPage({
      renderFailure: {
        message: "LegacyEventEmitter is not a constructor",
        stack: "TypeError: LegacyEventEmitter is not a constructor\n    at settings.js:1:1",
      },
    });

    await expect(assertStoryRendered(page, "pages-settings--default")).rejects.toThrow(
      "Storybook story pages-settings--default failed to render: TypeError: LegacyEventEmitter is not a constructor",
    );
  });

  it("fails when a screenshot story visibly reports a processing fetch error", async () => {
    const page = storybookPage({ processingError: "Failed to fetch" });

    await expect(assertStoryRendered(page, "pages-strain--with-activities")).rejects.toThrow(
      "Storybook story pages-strain--with-activities contains a processing error: Failed to fetch",
    );
  });
});

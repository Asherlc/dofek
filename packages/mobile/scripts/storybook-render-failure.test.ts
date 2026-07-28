import { describe, expect, it } from "vitest";
import { assertStoryRendered } from "./storybook-render-failure";

type StorybookPage = Parameters<typeof assertStoryRendered>[0];

interface StorybookRenderFailure {
  message: string;
  stack: string | null;
}

function storybookPage(failure?: StorybookRenderFailure): StorybookPage {
  return {
    locator(selector) {
      const text =
        selector === "#error-message:visible" ? failure?.message : (failure?.stack ?? null);
      return {
        count: async () => (failure == null ? 0 : 1),
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
      message: "LegacyEventEmitter is not a constructor",
      stack: "TypeError: LegacyEventEmitter is not a constructor\n    at settings.js:1:1",
    });

    await expect(assertStoryRendered(page, "pages-settings--default")).rejects.toThrow(
      "Storybook story pages-settings--default failed to render: TypeError: LegacyEventEmitter is not a constructor",
    );
  });
});

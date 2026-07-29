interface StorybookLocator {
  count(): Promise<number>;
  textContent(): Promise<string | null>;
}

interface StorybookPage {
  locator(selector: string): StorybookLocator;
}

export async function assertStoryRendered(page: StorybookPage, storyId: string): Promise<void> {
  const errorMessage = page.locator("#error-message:visible");
  if ((await errorMessage.count()) > 0) {
    const message = (await errorMessage.textContent())?.trim() || "Unknown Storybook render error";
    const errorStack = page.locator("#error-stack:visible");
    const stack = (await errorStack.count()) > 0 ? (await errorStack.textContent())?.trim() : null;
    const firstFatalLine = stack?.split(/\r?\n/, 1)[0] || message;
    throw new Error(`Storybook story ${storyId} failed to render: ${firstFatalLine}`);
  }

  const processingErrorHeading = page.locator('text="Processing status is unavailable"');
  if ((await processingErrorHeading.count()) > 0) {
    const fetchError = page.locator('text="Failed to fetch"');
    const detail =
      (await fetchError.count()) > 0 ? "Failed to fetch" : "Processing status is unavailable";
    throw new Error(`Storybook story ${storyId} contains a processing error: ${detail}`);
  }

  const queryError = page.locator('[data-testid="query-state-error"]:visible');
  if ((await queryError.count()) > 0) {
    throw new Error(`Storybook story ${storyId} contains a query error panel`);
  }
}

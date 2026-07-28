interface StorybookLocator {
  count(): Promise<number>;
  textContent(): Promise<string | null>;
}

interface StorybookPage {
  locator(selector: string): StorybookLocator;
}

export async function assertStoryRendered(page: StorybookPage, storyId: string): Promise<void> {
  const errorMessage = page.locator("#error-message:visible");
  if ((await errorMessage.count()) === 0) return;

  const message = (await errorMessage.textContent())?.trim() || "Unknown Storybook render error";
  const stack = (await page.locator("#error-stack:visible").textContent())?.trim();
  const firstFatalLine = stack?.split(/\r?\n/, 1)[0] || message;
  throw new Error(`Storybook story ${storyId} failed to render: ${firstFatalLine}`);
}

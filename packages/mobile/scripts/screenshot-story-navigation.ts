interface ScreenshotTabButton {
  click(): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
}

interface ScreenshotNavigationPage {
  getByRole(role: "button", options: { name: string; exact: true }): ScreenshotTabButton;
  waitForFunction(
    condition: (label: string) => boolean,
    label: string,
    options: { timeout: number },
  ): Promise<unknown>;
}

export async function selectScreenshotTab(
  page: ScreenshotNavigationPage,
  tabLabel?: string,
): Promise<void> {
  if (!tabLabel) return;
  const tab = page.getByRole("button", { name: tabLabel, exact: true });
  await tab.click();
  await page.waitForFunction(
    (label) =>
      Array.from(document.querySelectorAll('[role="button"]')).some(
        (button) =>
          (button.getAttribute("aria-label") === label || button.textContent?.trim() === label) &&
          button.getAttribute("aria-selected") === "true",
      ),
    tabLabel,
    { timeout: 5_000 },
  );
  if ((await tab.getAttribute("aria-selected")) !== "true") {
    throw new Error(`Screenshot tab "${tabLabel}" was not selected`);
  }
}

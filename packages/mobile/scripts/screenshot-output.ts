import { relative, sep } from "node:path";

interface ScreenshotPage {
  screenshot(options: { path: string }): Promise<unknown>;
}

export async function captureViewportScreenshot(
  page: ScreenshotPage,
  outputPath: string,
): Promise<void> {
  await page.screenshot({ path: outputPath });
}

export function manifestOutputPath(rootDirectory: string, outputPath: string): string {
  return relative(rootDirectory, outputPath).replaceAll(sep, "/");
}

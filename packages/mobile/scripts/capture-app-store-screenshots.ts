#!/usr/bin/env node

// cspell:words activitydetail networkidle zonecharts
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lightColors } from "../theme-palette";
import {
  devicePixelSize,
  requireStoryIdsInIndex,
  SCREENSHOT_CAPTURE_INSTANT,
  SCREENSHOT_DEVICES,
  SCREENSHOT_TIMEZONE,
  SCREENSHOTS,
  screenshotStoryIds,
} from "./screenshot-config";
import { captureViewportScreenshot, manifestOutputPath } from "./screenshot-output";
import { selectScreenshotTab, waitForScreenshotReadiness } from "./screenshot-story-navigation";
import { assertStoryRendered } from "./storybook-render-failure";
import { startStorybookStaticServer } from "./storybook-static-server";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(scriptDir, "..");
const storybookDir = join(mobileRoot, "storybook-static");
const outputDir = join(mobileRoot, "app-store", "screenshots");

type ManifestDevices = Record<
  string,
  {
    width: number;
    height: number;
    scale: number;
    label: string;
    screenshots: Array<{
      id: string;
      filename: string;
      caption: string;
      outputPath: string;
      pixelSize: string;
    }>;
  }
>;

async function ensurePlaywright(): Promise<typeof import("playwright").chromium> {
  const playwright = await import("playwright");
  return playwright.chromium;
}

/** Fill Storybook chrome with the app background after the story document exists. */
async function applyCaptureBackground(
  page: { addStyleTag(options: { content: string }): Promise<unknown> },
  background: string,
): Promise<void> {
  await page.addStyleTag({
    content: `html, body, #storybook-root, #root, .sb-show-main, #storybook-root > *, #root > * {
  background: ${background} !important;
  background-color: ${background} !important;
  min-height: 100vh !important;
}`,
  });
}

/** Move each staged PNG into place; leave prior files untouched until each rename succeeds. */
async function publishStagedCapture(
  stagingDir: string,
  manifestDevices: ManifestDevices,
): Promise<void> {
  for (const device of SCREENSHOT_DEVICES) {
    const stagedDeviceDir = join(stagingDir, device.key);
    const finalDeviceDir = join(outputDir, device.key);
    await mkdir(finalDeviceDir, { recursive: true });
    for (const shot of SCREENSHOTS) {
      await rename(join(stagedDeviceDir, shot.filename), join(finalDeviceDir, shot.filename));
    }
  }

  await writeFile(
    join(outputDir, "manifest.json"),
    `${JSON.stringify(
      {
        timezone: SCREENSHOT_TIMEZONE,
        fixedDate: SCREENSHOT_CAPTURE_INSTANT,
        devices: manifestDevices,
      },
      null,
      2,
    )}\n`,
  );
}

async function captureScreenshots(): Promise<void> {
  requireStoryIdsInIndex(storybookDir, screenshotStoryIds());

  const chromium = await ensurePlaywright();
  await mkdir(outputDir, { recursive: true });
  const stagingDir = await mkdtemp(join(outputDir, "capture-"));
  for (const device of SCREENSHOT_DEVICES) {
    await mkdir(join(stagingDir, device.key), { recursive: true });
  }

  const server = await startStorybookStaticServer(storybookDir);
  const manifestDevices: ManifestDevices = {};

  try {
    const browser = await chromium.launch();
    try {
      for (const device of SCREENSHOT_DEVICES) {
        const deviceDir = join(stagingDir, device.key);
        const context = await browser.newContext({
          viewport: { width: device.width, height: device.height },
          deviceScaleFactor: device.scale,
          timezoneId: SCREENSHOT_TIMEZONE,
        });
        const page = await context.newPage();
        await page.clock.install({ time: new Date(SCREENSHOT_CAPTURE_INSTANT) });

        const deviceScreenshots: ManifestDevices[string]["screenshots"] = [];

        for (const shot of SCREENSHOTS) {
          const url = `http://127.0.0.1:${server.port}/iframe.html?id=${shot.id}&viewMode=story`;
          console.log(`Capturing ${device.key}/${shot.filename} (${shot.id})`);
          await page.goto(url, { waitUntil: "networkidle" });
          await applyCaptureBackground(page, lightColors.background);
          await selectScreenshotTab(page, shot.tabLabel);
          await page.evaluate(() => window.scrollTo(0, 0));
          await waitForScreenshotReadiness(page, shot.readinessText);
          await assertStoryRendered(page, shot.id);
          if (shot.expandChartData) {
            await page.getByRole("button", { name: /View .* data/ }).click();
            await page.getByRole("button", { name: /Hide .* data/ }).waitFor({ state: "visible" });
          }
          // Re-apply after story interactions in case remount reset Storybook chrome styles.
          await applyCaptureBackground(page, lightColors.background);

          const stagedPath = join(deviceDir, shot.filename);
          const publishedPath = join(outputDir, device.key, shot.filename);
          await captureViewportScreenshot(page, stagedPath);
          deviceScreenshots.push({
            id: shot.id,
            filename: shot.filename,
            caption: shot.caption,
            outputPath: manifestOutputPath(mobileRoot, publishedPath),
            pixelSize: devicePixelSize(device),
          });
        }

        manifestDevices[device.key] = {
          width: device.width,
          height: device.height,
          scale: device.scale,
          label: device.label,
          screenshots: deviceScreenshots,
        };

        await context.close();
      }
    } finally {
      await browser.close();
    }

    await publishStagedCapture(stagingDir, manifestDevices);
  } finally {
    await server.close();
    await rm(stagingDir, { recursive: true, force: true });
  }

  const total = Object.values(manifestDevices).reduce(
    (count, device) => count + device.screenshots.length,
    0,
  );
  console.log(`\nSaved ${total} screenshots under ${outputDir}`);
}

async function main(): Promise<void> {
  if (!existsSync(join(storybookDir, "index.html"))) {
    throw new Error("Storybook build not found. Run: pnpm storybook:mobile:build");
  }

  await captureScreenshots();
}

void main();

#!/usr/bin/env node

// cspell:words activitydetail networkidle zonecharts
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureViewportScreenshot, manifestOutputPath } from "./screenshot-output";
import { selectScreenshotTab } from "./screenshot-story-navigation";
import { assertStoryRendered } from "./storybook-render-failure";
import { startStorybookStaticServer } from "./storybook-static-server";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(scriptDir, "..");
const storybookDir = join(mobileRoot, "storybook-static");
const outputDir = join(mobileRoot, "app-store", "screenshots");

const DEVICE = {
  width: 428,
  height: 926,
  scale: 3,
  label: "6.5-inch",
};

interface ScreenshotConfig {
  id: string;
  filename: string;
  caption: string;
  tabLabel?: string;
}

const SCREENSHOTS: ScreenshotConfig[] = [
  {
    id: "pages-home--default",
    filename: "01-today-readiness.png",
    caption: "See your daily readiness at a glance",
  },
  {
    id: "pages-recovery--default",
    filename: "02-recovery-trends.png",
    caption: "Track HRV, resting heart rate, and recovery trends",
  },
  {
    id: "pages-strain--with-activities",
    filename: "03-training-load.png",
    caption: "Balance training load with recovery",
  },
  {
    id: "pages-activities--default",
    filename: "04-activities-map.png",
    caption: "Review every workout with route previews",
  },
  {
    id: "pages-settings--default",
    filename: "06-connected-providers.png",
    caption: "Connect Strava, WHOOP, Apple Health, and more",
    tabLabel: "Connections",
  },
  {
    id: "pages-activitydetail-zonecharts--heart-rate-zones",
    filename: "07-heart-rate-zones.png",
    caption: "Inspect heart rate zone distribution",
  },
];

async function ensurePlaywright(): Promise<typeof import("playwright").chromium> {
  const playwright = await import("playwright");
  return playwright.chromium;
}

async function captureScreenshots(): Promise<void> {
  const chromium = await ensurePlaywright();
  await mkdir(outputDir, { recursive: true });

  const server = await startStorybookStaticServer(storybookDir);
  const manifest: Array<{
    id: string;
    filename: string;
    caption: string;
    outputPath: string;
    pixelSize: string;
  }> = [];

  try {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: DEVICE.width, height: DEVICE.height },
        deviceScaleFactor: DEVICE.scale,
      });
      const page = await context.newPage();

      for (const shot of SCREENSHOTS) {
        const url = `http://127.0.0.1:${server.port}/iframe.html?id=${shot.id}&viewMode=story`;
        console.log(`Capturing ${shot.filename} (${shot.id})`);
        await page.goto(url, { waitUntil: "networkidle" });
        await selectScreenshotTab(page, shot.tabLabel);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(1500);
        await assertStoryRendered(page, shot.id);

        const outputPath = join(outputDir, shot.filename);
        await captureViewportScreenshot(page, outputPath);
        manifest.push({
          id: shot.id,
          filename: shot.filename,
          caption: shot.caption,
          outputPath: manifestOutputPath(mobileRoot, outputPath),
          pixelSize: `${DEVICE.width * DEVICE.scale}x${DEVICE.height * DEVICE.scale}`,
        });
      }
    } finally {
      await browser.close();
    }

    await writeFile(
      join(outputDir, "manifest.json"),
      `${JSON.stringify({ device: DEVICE, screenshots: manifest }, null, 2)}\n`,
    );
  } finally {
    await server.close();
  }

  console.log(`\nSaved ${manifest.length} screenshots to ${outputDir}`);
}

async function main(): Promise<void> {
  if (!existsSync(join(storybookDir, "index.html"))) {
    throw new Error("Storybook build not found. Run: pnpm storybook:mobile:build");
  }

  await captureScreenshots();
}

void main();

#!/usr/bin/env node

// cspell:words activitydetail networkidle zonecharts
import { readFile as readFileCallback } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStoryRendered } from "./storybook-render-failure";

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
    id: "pages-nutrition--default",
    filename: "05-nutrition-logging.png",
    caption: "Log meals and track macros in one place",
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

function contentType(pathname: string): string {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function startStaticServer(rootDir: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);
      const filePath = join(rootDir, pathname === "/" ? "index.html" : pathname);
      readFileCallback(filePath, (error, file) => {
        if (error?.code === "ENOENT") {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        if (error) {
          response.destroy(error);
          return;
        }
        response.writeHead(200, { "Content-Type": contentType(filePath) });
        response.end(file);
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to start static server"));
        return;
      }
      resolvePromise({
        port: address.port,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}

async function ensurePlaywright(): Promise<typeof import("playwright").chromium> {
  const playwright = await import("playwright");
  return playwright.chromium;
}

async function captureScreenshots(): Promise<void> {
  const chromium = await ensurePlaywright();
  await mkdir(outputDir, { recursive: true });

  const server = await startStaticServer(storybookDir);
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
        if (shot.tabLabel) {
          await page.getByRole("button", { name: shot.tabLabel, exact: true }).click();
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(1500);
        await assertStoryRendered(page, shot.id);

        const outputPath = join(outputDir, shot.filename);
        await page.screenshot({
          path: outputPath,
          clip: {
            x: 0,
            y: 0,
            width: DEVICE.width * DEVICE.scale,
            height: DEVICE.height * DEVICE.scale,
          },
        });
        manifest.push({
          id: shot.id,
          filename: shot.filename,
          caption: shot.caption,
          outputPath: outputPath.replace(`${mobileRoot}/`, ""),
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
  try {
    await readFile(join(storybookDir, "index.html"));
  } catch (error: unknown) {
    throw new Error("Storybook build not found. Run: pnpm storybook:mobile:build", {
      cause: error,
    });
  }

  await captureScreenshots();
}

void main();

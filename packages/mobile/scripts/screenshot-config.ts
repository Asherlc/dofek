import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  SCREENSHOT_CAPTURE_INSTANT,
  SCREENSHOT_TIMEZONE,
} from "../app-fixtures/(tabs)/screenshot-profile";

export interface ScreenshotDevice {
  key: "iphone" | "ipad";
  width: number;
  height: number;
  scale: number;
  label: string;
}

export interface ScreenshotConfig {
  id: string;
  filename: string;
  caption: string;
  /** Visible text that must appear before capture succeeds. */
  readinessText: string;
  tabLabel?: string;
  /** Optional post-ready UI action before the viewport capture. */
  expandChartData?: boolean;
}

/** Portrait capture sizes accepted by App Store Connect for primary phone/tablet slots. */
export const SCREENSHOT_DEVICES: readonly ScreenshotDevice[] = [
  {
    key: "iphone",
    width: 428,
    height: 926,
    scale: 3,
    label: "6.5-inch",
  },
  {
    key: "ipad",
    width: 1024,
    height: 1366,
    scale: 2,
    label: "13-inch",
  },
] as const;

export { SCREENSHOT_CAPTURE_INSTANT, SCREENSHOT_TIMEZONE };

export const SCREENSHOTS: readonly ScreenshotConfig[] = [
  {
    id: "pages-overview--app-store-screenshot",
    filename: "01-today.png",
    caption: "See your health data at a glance",
    readinessText: "LAST NIGHT",
  },
  {
    id: "pages-recovery--default",
    filename: "02-recovery-trends.png",
    caption: "Track HRV, resting heart rate, and recovery trends",
    readinessText: "56 ms",
  },
  {
    id: "pages-strain--app-store-screenshot",
    filename: "03-training-load.png",
    caption: "Compare recent training load with your baseline",
    readinessText: "Training Load",
  },
  {
    id: "pages-activities--default",
    filename: "04-activities-map.png",
    caption: "Review workouts with route previews",
    readinessText: "Training time",
  },
  {
    id: "pages-settings--default",
    filename: "06-connected-providers.png",
    caption: "Connect Garmin, Apple Health, WHOOP, and more",
    readinessText: "3 connected",
    tabLabel: "Data Sources",
  },
  {
    id: "pages-activitydetail-zonecharts--heart-rate-zones",
    filename: "07-heart-rate-zones.png",
    caption: "Inspect heart rate zone distribution",
    readinessText: "Heart Rate Zones",
    expandChartData: true,
  },
] as const;

const storybookIndexSchema = z.object({
  entries: z.record(z.string(), z.unknown()).optional(),
});

export function screenshotStoryIds(
  screenshots: readonly ScreenshotConfig[] = SCREENSHOTS,
): string[] {
  return screenshots.map((screenshot) => screenshot.id);
}

export function missingStoryIds(
  entries: Record<string, unknown>,
  storyIds: readonly string[],
): string[] {
  return storyIds.filter((storyId) => entries[storyId] == null);
}

export function requireStoryIdsInIndex(storybookDir: string, storyIds: readonly string[]): void {
  const indexPath = join(storybookDir, "index.json");
  const parsed = storybookIndexSchema.safeParse(JSON.parse(readFileSync(indexPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`Storybook index at ${indexPath} is not a valid story index`);
  }
  const missing = missingStoryIds(parsed.data.entries ?? {}, storyIds);
  if (missing.length > 0) {
    throw new Error(
      `Storybook index is missing required screenshot stories: ${missing.join(", ")}`,
    );
  }
}

export function devicePixelSize(device: ScreenshotDevice): string {
  return `${device.width * device.scale}x${device.height * device.scale}`;
}

import { generateCsv } from "./csv.ts";
import { generateFit } from "./fit.ts";
import { generateGpx, hasGpsPoints } from "./gpx.ts";
import { generateTcx } from "./tcx.ts";
import type { ActivityExportFormat, ActivityExportInput, ActivityExportResult } from "./types.ts";

export class ActivityExportError extends Error {
  readonly code: "NO_GPS" | "UNSUPPORTED_FORMAT";

  constructor(code: ActivityExportError["code"], message: string) {
    super(message);
    this.name = "ActivityExportError";
    this.code = code;
  }
}

function sanitizeFilenamePart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized.slice(0, 80) : "activity";
}

export function buildActivityExportFilename(
  activity: ActivityExportInput,
  format: ActivityExportFormat,
): string {
  const base = sanitizeFilenamePart(activity.name ?? activity.activityType);
  return `${base}-${activity.id.slice(0, 8)}.${format}`;
}

export function serializeActivityExport(
  activity: ActivityExportInput,
  format: ActivityExportFormat,
): ActivityExportResult {
  const filename = buildActivityExportFilename(activity, format);

  switch (format) {
    case "gpx": {
      if (!hasGpsPoints(activity)) {
        throw new ActivityExportError(
          "NO_GPS",
          "GPX export requires GPS track points for this activity.",
        );
      }
      return {
        body: Buffer.from(generateGpx(activity), "utf-8"),
        contentType: "application/gpx+xml",
        filename,
      };
    }
    case "tcx": {
      if (!hasGpsPoints(activity)) {
        throw new ActivityExportError(
          "NO_GPS",
          "TCX export requires GPS track points for this activity.",
        );
      }
      return {
        body: Buffer.from(generateTcx(activity), "utf-8"),
        contentType: "application/vnd.garmin.tcx+xml",
        filename,
      };
    }
    case "csv":
      return {
        body: Buffer.from(generateCsv(activity), "utf-8"),
        contentType: "text/csv; charset=utf-8",
        filename,
      };
    case "fit":
      return {
        body: generateFit(activity),
        contentType: "application/vnd.ant.fit",
        filename,
      };
    default:
      throw new ActivityExportError("UNSUPPORTED_FORMAT", `Unsupported export format: ${format}`);
  }
}

export type {
  ActivityExportFormat,
  ActivityExportInput,
  ActivityExportPoint,
  ActivityExportResult,
} from "./types.ts";

import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { z } from "zod";
import { createMobileExportCacheFile } from "./mobile-export-cache";
import { captureException } from "./telemetry";

export type ActivityExportFormat = "gpx" | "tcx" | "csv" | "fit";

const exportErrorSchema = z.object({
  error: z.string().optional(),
});

const CONTENT_TYPES: Record<ActivityExportFormat, string> = {
  gpx: "application/gpx+xml",
  tcx: "application/vnd.garmin.tcx+xml",
  csv: "text/csv",
  fit: "application/vnd.ant.fit",
};

function getFilenameFromContentDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? fallback;
}

export interface DownloadActivityExportArgs {
  activityId: string;
  format: ActivityExportFormat;
  serverUrl: string;
  sessionToken: string;
}

export async function downloadActivityExport({
  activityId,
  format,
  serverUrl,
  sessionToken,
}: DownloadActivityExportArgs): Promise<void> {
  const baseUrl = serverUrl.replace(/\/+$/, "");
  const exportUrl = `${baseUrl}/api/activity/${activityId}/export?format=${format}`;
  const fallbackFilename = `activity-${activityId.slice(0, 8)}.${format}`;
  const operationId = Crypto.randomUUID();
  const uniqueFilename = (filename: string): string => `export-${operationId}-${filename}`;
  const tempUri = createMobileExportCacheFile(uniqueFilename(fallbackFilename)).uri;
  const createdUris = new Set([tempUri]);
  let cleanupFailure: Error | null = null;

  try {
    const downloadResult = await FileSystem.downloadAsync(exportUrl, tempUri, {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    if (downloadResult.status < 200 || downloadResult.status >= 300) {
      let message = `Export failed (${downloadResult.status})`;
      try {
        const body = await FileSystem.readAsStringAsync(downloadResult.uri);
        const parsed = exportErrorSchema.safeParse(JSON.parse(body));
        if (parsed.success && parsed.data.error) message = parsed.data.error;
      } catch (error) {
        captureException(error, { source: "activity-export.parse-error-response" });
      }
      throw new Error(message);
    }

    const filename = getFilenameFromContentDisposition(
      downloadResult.headers["content-disposition"] ??
        downloadResult.headers["Content-Disposition"] ??
        null,
      fallbackFilename,
    );
    let fileUri: string;
    try {
      fileUri = createMobileExportCacheFile(uniqueFilename(filename)).uri;
    } catch (error: unknown) {
      captureException(error, { source: "activity-export.filename" });
      throw new Error("Activity export filename is invalid");
    }
    createdUris.add(fileUri);

    if (fileUri !== tempUri) {
      await FileSystem.moveAsync({ from: tempUri, to: fileUri });
    }

    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) {
      throw new Error("Sharing is not available on this device.");
    }

    await Sharing.shareAsync(fileUri, {
      mimeType: CONTENT_TYPES[format],
      dialogTitle: "Export Activity",
    });
  } finally {
    for (const uri of createdUris) {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {
        cleanupFailure = new Error("Activity export cache cleanup failed.");
        captureException(cleanupFailure, {
          source: "activity-export-cache-cleanup",
        });
      }
    }
  }
  if (cleanupFailure) {
    throw new Error("The activity export was shared, but its temporary file could not be removed.");
  }
}

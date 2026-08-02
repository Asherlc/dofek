import { formatDateMedium } from "@dofek/format/format";
import { File as ExpoFile, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { z } from "zod";
import { captureException } from "../lib/telemetry";
import { colors } from "../theme";

type ExportState = "idle" | "processing" | "done" | "error";

const ExportTriggerSchema = z.object({
  exportId: z.string(),
  status: z.literal("queued"),
});

const DataExportSchema = z.object({
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  errorMessage: z.string().nullable(),
  expiresAt: z.string(),
  filename: z.string(),
  id: z.string(),
  sizeBytes: z.number().nullable(),
  startedAt: z.string().nullable(),
  status: z.enum(["queued", "processing", "completed", "failed"]),
});

const ExportListSchema = z.object({ exports: z.array(DataExportSchema) });
type DataExport = z.infer<typeof DataExportSchema>;
const ErrorResponseSchema = z.object({
  error: z
    .union([
      z.string(),
      z.object({
        message: z.string(),
      }),
    ])
    .optional(),
  message: z.string().optional(),
});

interface DataExportSectionProps {
  serverUrl: string;
  sessionToken: string | null;
}

function formatExportSize(sizeBytes: number | null): string {
  if (sizeBytes == null) return "Size pending";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatExportDate(value: string): string {
  return formatDateMedium(value);
}

function getAuthHeaders(sessionToken: string): { Authorization: string } {
  return { Authorization: `Bearer ${sessionToken}` };
}

function getUsableSessionToken(sessionToken: string | null): string | null {
  const trimmedSessionToken = sessionToken?.trim();
  return trimmedSessionToken ? trimmedSessionToken : null;
}

async function getResponseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const parsed = ErrorResponseSchema.safeParse(await response.json());
    if (!parsed.success) return fallback;
    if (typeof parsed.data.error === "string") return parsed.data.error;
    if (parsed.data.error?.message) return parsed.data.error.message;
    return parsed.data.message ?? fallback;
  } catch (error: unknown) {
    captureException(error, { source: "data-export-response-error-json" });
    return fallback;
  }
}

function getExportCacheFilename(dataExport: DataExport): string {
  const safeFilename = dataExport.filename.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${dataExport.id}-${safeFilename || "health-export.zip"}`;
}

export function DataExportSection({ serverUrl, sessionToken }: DataExportSectionProps) {
  const [exportState, setExportState] = useState<ExportState>("idle");
  const [exportMessage, setExportMessage] = useState("");
  const [dataExports, setDataExports] = useState<DataExport[]>([]);
  const [exportsLoading, setExportsLoading] = useState(true);
  const [downloadingExportId, setDownloadingExportId] = useState<string | null>(null);
  const isMounted = useRef(false);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const loadExports = useCallback(async () => {
    if (!isMounted.current) return;

    const usableSessionToken = getUsableSessionToken(sessionToken);
    if (!usableSessionToken) {
      setExportState("error");
      setExportMessage("Sign in again to load exports.");
      setExportsLoading(false);
      return;
    }

    try {
      const response = await fetch(`${serverUrl}/api/export`, {
        headers: getAuthHeaders(usableSessionToken),
      });
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, "Failed to load exports"));
      }
      const parsed = ExportListSchema.parse(await response.json());
      if (!isMounted.current) return;
      setDataExports(parsed.exports);
      setExportMessage("");
    } catch (error: unknown) {
      captureException(error, { context: "data-export-list" });
      if (!isMounted.current) return;
      setExportState("error");
      setExportMessage(error instanceof Error ? error.message : "Failed to load exports");
    } finally {
      if (isMounted.current) {
        setExportsLoading(false);
      }
    }
  }, [serverUrl, sessionToken]);

  useEffect(() => {
    loadExports();
  }, [loadExports]);

  async function handleExport() {
    const usableSessionToken = getUsableSessionToken(sessionToken);
    if (!usableSessionToken) {
      setExportState("error");
      setExportMessage("Sign in again to start an export.");
      return;
    }

    setExportState("processing");
    setExportMessage("Starting export...");

    try {
      const triggerRes = await fetch(`${serverUrl}/api/export`, {
        method: "POST",
        headers: getAuthHeaders(usableSessionToken),
      });

      if (!triggerRes.ok) {
        const message = await getResponseErrorMessage(triggerRes, "Failed to start export");
        if (!isMounted.current) return;
        setExportState("error");
        setExportMessage(message);
        return;
      }

      ExportTriggerSchema.parse(await triggerRes.json());
      if (!isMounted.current) return;
      setExportState("done");
      await loadExports();
    } catch (error: unknown) {
      captureException(error, { context: "data-export" });
      if (!isMounted.current) return;
      setExportState("error");
      setExportMessage("Network error during export");
    }
  }

  async function handleDownloadExport(dataExport: DataExport) {
    const usableSessionToken = getUsableSessionToken(sessionToken);
    if (!usableSessionToken) {
      setExportState("error");
      setExportMessage("Sign in again to download exports.");
      return;
    }

    setDownloadingExportId(dataExport.id);
    setExportMessage("Downloading...");
    try {
      const file = new ExpoFile(Paths.cache, getExportCacheFilename(dataExport));
      await ExpoFile.downloadFileAsync(`${serverUrl}/api/export/download/${dataExport.id}`, file, {
        headers: getAuthHeaders(usableSessionToken),
        idempotent: true,
      });
      if (!isMounted.current) return;
      setExportState("done");
      setExportMessage("Export ready");
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/zip",
        dialogTitle: "Save Health Data Export",
      });
    } catch (error: unknown) {
      captureException(error, { context: "data-export-download" });
      if (!isMounted.current) return;
      setExportState("error");
      setExportMessage(error instanceof Error ? error.message : "Failed to download export");
    } finally {
      if (isMounted.current) {
        setDownloadingExportId(null);
      }
    }
  }

  const activeExports = dataExports.filter(
    (dataExport) => dataExport.status === "queued" || dataExport.status === "processing",
  );
  const completedExports = dataExports.filter((dataExport) => dataExport.status === "completed");
  const hasActiveExport = activeExports.length > 0;
  const exportBlocked = exportState === "processing" || exportsLoading || hasActiveExport;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Data Export</Text>
      <Text style={styles.sectionDescription}>
        Create a ZIP file containing CSV files for your health data
      </Text>
      <View style={styles.card}>
        {hasActiveExport && (
          <View style={styles.exportStatusContainer}>
            <Text style={styles.exportStatusTitle}>Export in progress</Text>
            <Text style={styles.exportMessageText}>We'll email you when it finishes.</Text>
          </View>
        )}
        {exportState === "done" && !hasActiveExport && (
          <Text style={styles.exportDoneText}>{exportMessage}</Text>
        )}
        {exportState === "error" && <Text style={styles.exportErrorText}>{exportMessage}</Text>}
        <TouchableOpacity
          style={[styles.exportButton, exportBlocked && styles.exportButtonDisabled]}
          onPress={handleExport}
          activeOpacity={0.7}
          disabled={exportBlocked}
          accessibilityRole="button"
          accessibilityLabel={
            exportState === "processing" || hasActiveExport ? "Export in progress" : "Start Export"
          }
          accessibilityState={{
            busy: exportState === "processing" || hasActiveExport,
            disabled: exportBlocked,
          }}
        >
          <Text style={styles.exportButtonText}>
            {exportState === "processing"
              ? "Starting..."
              : hasActiveExport
                ? "Export Running"
                : "Start Export"}
          </Text>
        </TouchableOpacity>
        <View style={styles.exportListContainer}>
          <Text style={styles.exportListTitle}>Available exports</Text>
          {exportsLoading ? (
            <Text style={styles.exportMessageText}>Loading exports...</Text>
          ) : completedExports.length === 0 ? (
            <Text style={styles.exportMessageText}>No exports available.</Text>
          ) : (
            completedExports.map((dataExport) => (
              <View key={dataExport.id} style={styles.exportListRow}>
                <View style={styles.exportListInfo}>
                  <Text style={styles.exportFilename}>{dataExport.filename}</Text>
                  <Text style={styles.exportMessageText}>
                    {formatExportSize(dataExport.sizeBytes)} - Expires{" "}
                    {formatExportDate(dataExport.expiresAt)}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => handleDownloadExport(dataExport)}
                  activeOpacity={0.7}
                  disabled={downloadingExportId !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`Download ${dataExport.filename}`}
                  accessibilityState={{
                    busy: downloadingExportId === dataExport.id,
                    disabled: downloadingExportId !== null,
                  }}
                >
                  <Text style={styles.exportDownloadText}>
                    {downloadingExportId === dataExport.id
                      ? "Downloading..."
                      : `Download ${dataExport.filename}`}
                  </Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  sectionDescription: {
    fontSize: 13,
    color: colors.textTertiary,
    marginBottom: 10,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
  },
  exportStatusContainer: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    gap: 2,
    marginBottom: 12,
    padding: 12,
  },
  exportStatusTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  exportMessageText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  exportDoneText: {
    fontSize: 13,
    color: colors.positive,
    marginBottom: 12,
  },
  exportErrorText: {
    fontSize: 13,
    color: colors.danger,
    marginBottom: 12,
  },
  exportButton: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  exportButtonDisabled: {
    opacity: 0.5,
  },
  exportButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  exportListContainer: {
    gap: 10,
    marginTop: 16,
  },
  exportListTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  exportListRow: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingTop: 10,
  },
  exportListInfo: {
    flex: 1,
    gap: 2,
  },
  exportFilename: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  exportDownloadText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.blue,
  },
});

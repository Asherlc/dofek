import { useCallback, useEffect, useMemo, useState } from "react";
import { captureException } from "../lib/telemetry.ts";

type ExportStatus = "queued" | "processing" | "completed" | "failed";

interface DataExport {
  completedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  expiresAt: string;
  filename: string;
  id: string;
  sizeBytes: number | null;
  startedAt: string | null;
  status: ExportStatus;
}

interface ExportListResponse {
  exports: DataExport[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isDataExport(value: unknown): value is DataExport {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    ["queued", "processing", "completed", "failed"].includes(value.status) &&
    typeof value.filename === "string" &&
    (typeof value.sizeBytes === "number" || value.sizeBytes === null) &&
    typeof value.createdAt === "string" &&
    (typeof value.startedAt === "string" || value.startedAt === null) &&
    (typeof value.completedAt === "string" || value.completedAt === null) &&
    typeof value.expiresAt === "string" &&
    (typeof value.errorMessage === "string" || value.errorMessage === null)
  );
}

function isExportListResponse(value: unknown): value is ExportListResponse {
  return isRecord(value) && Array.isArray(value.exports) && value.exports.every(isDataExport);
}

function formatBytes(sizeBytes: number | null): string {
  if (sizeBytes == null) return "Size pending";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

async function fetchExports(): Promise<DataExport[]> {
  const response = await fetch("/api/export", { credentials: "include" });
  if (!response.ok) {
    throw new Error("Failed to load exports");
  }
  const body: unknown = await response.json();
  if (!isExportListResponse(body)) {
    throw new Error("Unexpected export list response");
  }
  return body.exports;
}

export function ExportPanel() {
  const [exports, setExports] = useState<DataExport[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(false);

  const activeExports = useMemo(
    () =>
      exports.filter(
        (dataExport) => dataExport.status === "queued" || dataExport.status === "processing",
      ),
    [exports],
  );
  const completedExports = useMemo(
    () => exports.filter((dataExport) => dataExport.status === "completed"),
    [exports],
  );
  const hasActiveExport = activeExports.length > 0;

  const refreshExports = useCallback(async () => {
    try {
      setExports(await fetchExports());
      setMessage("");
    } catch (error: unknown) {
      captureException(error, { context: "data-export-list" });
      setMessage(error instanceof Error ? error.message : "Failed to load exports");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshExports();
  }, [refreshExports]);

  useEffect(() => {
    if (!hasActiveExport) {
      return;
    }
    const intervalId = window.setInterval(() => {
      refreshExports();
    }, 10_000);
    return () => window.clearInterval(intervalId);
  }, [hasActiveExport, refreshExports]);

  async function startExport() {
    setStarting(true);
    setMessage("Starting export...");

    try {
      const triggerRes = await fetch("/api/export", {
        method: "POST",
        credentials: "include",
      });

      if (!triggerRes.ok) {
        throw new Error("Failed to start export");
      }

      await refreshExports();
    } catch (error: unknown) {
      captureException(error, { context: "data-export-start" });
      setMessage(error instanceof Error ? error.message : "Failed to start export");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Create a ZIP file containing CSV files for your health data. Large exports run in the
        background.
      </p>

      {hasActiveExport && (
        <div className="rounded border border-border bg-accent/5 px-3 py-2">
          <p className="text-sm font-medium text-primary">Export in progress</p>
          <p className="text-xs text-subtle">We'll email you when it finishes.</p>
        </div>
      )}

      {message && !hasActiveExport && <p className="text-sm text-red-400">{message}</p>}

      <button
        type="button"
        onClick={startExport}
        disabled={starting || hasActiveExport}
        className="inline-flex items-center gap-2 text-sm border border-border-strong rounded px-4 py-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent/10"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <title>Export</title>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        {starting ? "Starting..." : hasActiveExport ? "Export Running" : "Start Export"}
      </button>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-primary">Available exports</h3>
        {loading ? (
          <p className="text-xs text-subtle">Loading exports...</p>
        ) : completedExports.length === 0 ? (
          <p className="text-xs text-subtle">No exports available.</p>
        ) : (
          <ul className="space-y-2">
            {completedExports.map((dataExport) => (
              <li
                key={dataExport.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2"
              >
                <div>
                  <p className="text-sm text-primary">{dataExport.filename}</p>
                  <p className="text-xs text-subtle">
                    {formatBytes(dataExport.sizeBytes)} - Expires {formatDate(dataExport.expiresAt)}
                  </p>
                </div>
                <a
                  className="text-sm text-blue-400 hover:text-blue-300"
                  href={`/api/export/download/${dataExport.id}`}
                >
                  Download {dataExport.filename}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

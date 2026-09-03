import { formatTime } from "@dofek/format/format";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import {
  type FileUploadApi,
  type FileUploadPhase,
  indexedDbUploadSessionStore,
  runResumableFileUpload,
  type UploadImportType,
} from "../lib/resumable-file-upload.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitSystem } from "../lib/unitContext.ts";
import type { SyncLogEntry, SyncStatus } from "./DataSourcesSyncTypes.ts";
import { FileImportButton } from "./FileImportButton.tsx";
import { OperationProgressBar } from "./OperationProgressBar.tsx";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { ProviderStatsBreakdown } from "./ProviderStatsBreakdown.tsx";
import { StatusDot } from "./StatusDot.tsx";

type DisplayPhase = FileUploadPhase | "idle";

export interface FileImportZoneProps {
  providerId?: string;
  importType: UploadImportType;
  title: string;
  description: string;
  accept: string;
  fullSync?: boolean;
  weightUnit?: "kg" | "lbs";
  stats?: ProviderStats;
  recentLogs?: SyncLogEntry[];
  showDetailsLink?: boolean;
  activeImport?: {
    jobId: string;
    status: "queued" | "running" | "completed" | "failed";
    percentage?: number;
    message?: string;
    failedCount?: number;
  };
}

function syncStatus(phase: DisplayPhase): SyncStatus {
  if (phase === "completed") return "done";
  if (phase === "failed") return "error";
  if (["preparing", "uploading", "verifying", "queueing", "processing"].includes(phase)) {
    return "syncing";
  }
  return "idle";
}

function uploadIdFromJobId(jobId: string): string | null {
  return jobId.startsWith("file-import-") ? jobId.slice("file-import-".length) : null;
}

export function FileImportZone({
  providerId,
  importType,
  title,
  description,
  accept,
  fullSync,
  weightUnit,
  stats,
  recentLogs = [],
  showDetailsLink = true,
  activeImport,
}: FileImportZoneProps) {
  const { unitSystem } = useUnitSystem();
  const [selectedWeightUnitOverride, setSelectedWeightUnitOverride] = useState<"kg" | "lbs" | null>(
    null,
  );
  const selectedWeightUnit =
    selectedWeightUnitOverride ?? weightUnit ?? (unitSystem === "imperial" ? "lbs" : "kg");
  const [state, setState] = useState<{
    phase: DisplayPhase;
    progress: number;
    message?: string;
    failedCount?: number;
  }>({ phase: "idle", progress: 0 });
  const [dragOver, setDragOver] = useState(false);
  const [successfullyCancelledUploadId, setSuccessfullyCancelledUploadId] = useState<string | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const localUploadActiveRef = useRef(false);
  const uploadInProgressRef = useRef(false);
  const uploadGenerationRef = useRef(0);
  const currentUploadIdRef = useRef<string | null>(null);
  const cancelledUploadIdRef = useRef<string | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const validProviderId = providerId?.length ? providerId : null;
  const sessionKey = providerId ?? importType;
  const activeImportUploadId = activeImport ? uploadIdFromJobId(activeImport.jobId) : null;
  const activeImportWasCancelled =
    activeImportUploadId !== null && activeImportUploadId === successfullyCancelledUploadId;
  const activeImportInProgress =
    (activeImport?.status === "queued" || activeImport?.status === "running") &&
    !activeImportWasCancelled;
  const { mutateAsync: initiateUpload } = trpc.fileUpload.initiate.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const { mutateAsync: authorizeUploadParts } = trpc.fileUpload.authorizeParts.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const { mutateAsync: completeUpload } = trpc.fileUpload.complete.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const { mutateAsync: abortUpload } = trpc.fileUpload.abort.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const trpcUtils = trpc.useUtils();

  const invalidateImportedData = useCallback(async () => {
    if (!validProviderId) return;
    try {
      await Promise.all([
        trpcUtils.providerDetail.availableDataTypes.invalidate({ providerId: validProviderId }),
        trpcUtils.providerDetail.logs.invalidate({ providerId: validProviderId }),
        trpcUtils.providerDetail.records.invalidate(),
        trpcUtils.sync.providerStats.invalidate(),
      ]);
    } catch (error) {
      captureException(error, { tags: { providerId: validProviderId } });
    }
  }, [trpcUtils, validProviderId]);

  const uploadApi = useMemo<FileUploadApi>(
    () => ({
      initiate: initiateUpload,
      authorizeParts: authorizeUploadParts,
      complete: completeUpload,
      abort: abortUpload,
      resume: (input) => trpcUtils.client.fileUpload.resume.query(input),
    }),
    [abortUpload, authorizeUploadParts, completeUpload, initiateUpload, trpcUtils],
  );

  const waitForNextPoll = useCallback(
    () =>
      new Promise<void>((resolve) => {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          resolve();
        }, 1_000);
      }),
    [],
  );

  const pollUpload = useCallback(
    async (uploadId: string, signal?: AbortSignal) => {
      currentUploadIdRef.current = uploadId;
      while (!stoppedRef.current && !signal?.aborted) {
        let result: Awaited<ReturnType<FileUploadApi["resume"]>>;
        try {
          result = await uploadApi.resume({ uploadId });
        } catch (error) {
          if (stoppedRef.current || signal?.aborted) return;
          captureException(error, { tags: { uploadId } });
          setState({
            phase: "failed",
            progress: 0,
            message: error instanceof Error ? error.message : "Upload status is unavailable",
          });
          return;
        }
        if (stoppedRef.current || signal?.aborted) return;
        const upload = result.upload;
        if (upload.state === "completed") {
          setState({ phase: "completed", progress: 100, message: "Import completed" });
          await invalidateImportedData();
          return;
        }
        if (upload.state === "failed") {
          setState({
            phase: "failed",
            progress: upload.progressPercent,
            message: upload.errorMessage ?? "Import failed",
          });
          return;
        }
        if (upload.state === "aborted" || upload.state === "expired") {
          setState({
            phase: "cancelled",
            progress: upload.progressPercent,
            message: upload.state === "expired" ? "Upload expired" : "Upload cancelled",
          });
          return;
        }
        setState({
          phase: upload.state === "queued" ? "queueing" : "processing",
          progress: upload.progressPercent,
          message: upload.state === "queued" ? "Import queued..." : "Processing import...",
        });
        await waitForNextPoll();
      }
    },
    [invalidateImportedData, uploadApi, waitForNextPoll],
  );

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const sessionGeneration = uploadGenerationRef.current;
    stoppedRef.current = false;
    void indexedDbUploadSessionStore
      .get(sessionKey)
      .then((session) => {
        if (
          session &&
          sessionGeneration === uploadGenerationRef.current &&
          !uploadInProgressRef.current &&
          !activeImportInProgress &&
          !stoppedRef.current &&
          !signal.aborted
        ) {
          currentUploadIdRef.current = session.uploadId;
          setState({
            phase: "cancelled",
            progress: 0,
            message: "Select the same file to resume upload",
          });
        }
      })
      .catch((error: unknown) => {
        if (
          sessionGeneration !== uploadGenerationRef.current ||
          uploadInProgressRef.current ||
          activeImportInProgress ||
          stoppedRef.current ||
          signal.aborted
        ) {
          return;
        }
        captureException(error, { tags: { uploadId: "pending" } });
        setState({
          phase: "failed",
          progress: 0,
          message: error instanceof Error ? error.message : "Upload session storage is unavailable",
        });
      });
    if (activeImportUploadId && activeImportUploadId !== cancelledUploadIdRef.current) {
      pollControllerRef.current?.abort();
      pollControllerRef.current = controller;
      void pollUpload(activeImportUploadId, signal);
    }
    return () => {
      stoppedRef.current = true;
      controller.abort();
      pollControllerRef.current?.abort();
      pollControllerRef.current = null;
      abortControllerRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [activeImportInProgress, activeImportUploadId, pollUpload, sessionKey]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (uploadInProgressRef.current || activeImportInProgress) return;
      const uploadGeneration = ++uploadGenerationRef.current;
      uploadInProgressRef.current = true;
      pollControllerRef.current?.abort();
      pollControllerRef.current = null;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      localUploadActiveRef.current = true;
      currentUploadIdRef.current = null;
      stoppedRef.current = false;
      try {
        const completed = await runResumableFileUpload({
          api: uploadApi,
          file,
          importType,
          providerId: sessionKey,
          sessionStore: indexedDbUploadSessionStore,
          signal: abortController.signal,
          fullSync,
          weightUnit: importType === "strong-csv" ? selectedWeightUnit : weightUnit,
          onUploadInitiated: (uploadId) => {
            currentUploadIdRef.current = uploadId;
          },
          onProgress: (progress) =>
            setState({
              phase: progress.phase,
              progress: progress.percentage,
              message: progress.message,
            }),
        });
        localUploadActiveRef.current = false;
        currentUploadIdRef.current = completed.uploadId;
        const pollController = abortController.signal.aborted
          ? new AbortController()
          : abortController;
        if (pollController !== abortController) {
          stoppedRef.current = false;
          cancelledUploadIdRef.current = null;
          abortControllerRef.current = pollController;
        }
        pollControllerRef.current = pollController;
        setState({ phase: "processing", progress: 0, message: "Processing import..." });
        await pollUpload(completed.uploadId, pollController.signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setState({ phase: "cancelled", progress: 0, message: "Upload cancelled" });
          return;
        }
        captureException(error, { tags: { uploadId: currentUploadIdRef.current ?? "pending" } });
        setState({
          phase: "failed",
          progress: 0,
          message: error instanceof Error ? error.message : "Upload failed",
        });
      } finally {
        localUploadActiveRef.current = false;
        if (uploadGeneration === uploadGenerationRef.current) uploadInProgressRef.current = false;
        if (abortControllerRef.current === abortController) abortControllerRef.current = null;
      }
    },
    [
      activeImportInProgress,
      fullSync,
      importType,
      pollUpload,
      selectedWeightUnit,
      sessionKey,
      uploadApi,
      weightUnit,
    ],
  );

  const cancelUpload = useCallback(async () => {
    const localUploadActive = localUploadActiveRef.current;
    abortControllerRef.current?.abort();
    pollControllerRef.current?.abort();
    stoppedRef.current = true;
    const uploadId = currentUploadIdRef.current;
    cancelledUploadIdRef.current = uploadId;
    let cancellationError: unknown;
    if (!localUploadActive && uploadId) {
      try {
        await uploadApi.abort({ uploadId });
        setSuccessfullyCancelledUploadId(uploadId);
      } catch (error) {
        cancellationError = error;
        captureException(error, { tags: { uploadId } });
      } finally {
        try {
          await trpcUtils.sync.activeImports.invalidate();
        } catch (error) {
          captureException(error, { tags: { uploadId } });
        }
      }
    }
    if (!localUploadActive && uploadId) {
      try {
        await indexedDbUploadSessionStore.delete(sessionKey);
      } catch (error) {
        captureException(error, { tags: { uploadId } });
        setState({
          phase: "failed",
          progress: 0,
          message: error instanceof Error ? error.message : "Local upload cleanup failed",
        });
        return;
      }
    }
    if (!localUploadActive && uploadId && cancellationError) {
      const pollController = new AbortController();
      stoppedRef.current = false;
      cancelledUploadIdRef.current = null;
      pollControllerRef.current = pollController;
      setState({
        phase: "processing",
        progress: 0,
        message:
          cancellationError instanceof Error
            ? `Unable to cancel import. ${cancellationError.message}`
            : "Unable to cancel import. Import status is being refreshed.",
      });
      void pollUpload(uploadId, pollController.signal);
      return;
    }
    setState({
      phase: "cancelled",
      progress: 0,
      message:
        cancellationError instanceof Error
          ? `Upload cancelled locally. ${cancellationError.message}`
          : "Upload cancelled",
    });
  }, [pollUpload, sessionKey, trpcUtils, uploadApi]);

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void uploadFile(file);
    },
    [uploadFile],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragOver(false);
      const file = event.dataTransfer.files[0];
      if (file) void uploadFile(file);
    },
    [uploadFile],
  );

  const status = syncStatus(state.phase);
  const active = status === "syncing";

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        {providerId && <ProviderLogo provider={providerId} size={18} />}
        <StatusDot status={status} />
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <section
        aria-label={`${title} file drop zone`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`rounded border-2 border-dashed p-3 text-center cursor-pointer transition-colors ${
          dragOver
            ? "border-blue-500 bg-blue-500/10"
            : "border-border-strong hover:border-border-strong bg-surface/30"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          onChange={handleFileSelect}
          className="hidden"
        />
        {active ? (
          <div>
            <OperationProgressBar percentage={state.progress} message={state.message} />
            <button type="button" className="mt-2 text-xs text-red-400" onClick={cancelUpload}>
              Cancel
            </button>
            {typeof state.failedCount === "number" && state.failedCount > 0 && (
              <div className="mt-1 text-xs text-amber-400">
                {state.failedCount.toLocaleString()} file
                {state.failedCount === 1 ? "" : "s"} failed
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-dim">{state.message ?? description}</div>
            {importType === "strong-csv" && (
              <label className="inline-flex items-center gap-2 text-xs text-muted">
                Weight unit
                <select
                  aria-label="Weight unit"
                  value={selectedWeightUnit}
                  onChange={(event) =>
                    setSelectedWeightUnitOverride(event.target.value === "lbs" ? "lbs" : "kg")
                  }
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
                >
                  <option value="kg">kg</option>
                  <option value="lbs">lbs</option>
                </select>
              </label>
            )}
            <FileImportButton onClick={() => fileInputRef.current?.click()} />
          </div>
        )}
      </section>
      {stats && <ProviderStatsBreakdown stats={stats} />}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
        <div className="flex items-center gap-1">
          {recentLogs.map((logEntry) => (
            <span
              key={`${logEntry.syncedAt}-${logEntry.status}-${logEntry.recordCount}-${logEntry.durationMs}`}
              className={`w-1.5 h-1.5 rounded-full ${
                logEntry.status === "success" ? "bg-emerald-400" : "bg-red-400"
              }`}
              title={`${logEntry.status} — ${formatTime(logEntry.syncedAt)}`}
            />
          ))}
        </div>
        {validProviderId && showDetailsLink && (
          <Link
            to="/providers/$id"
            params={{ id: validProviderId }}
            className="text-xs text-dim hover:text-muted transition-colors"
          >
            Details
          </Link>
        )}
      </div>
    </div>
  );
}

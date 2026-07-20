import { formatTime } from "@dofek/format/format";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { captureException } from "@sentry/react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type FileUploadApi,
  type FileUploadPhase,
  indexedDbUploadSessionStore,
  runResumableFileUpload,
  type UploadImportType,
} from "../lib/resumable-file-upload.ts";
import { trpc } from "../lib/trpc.ts";
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
  const [state, setState] = useState<{
    phase: DisplayPhase;
    progress: number;
    message?: string;
    failedCount?: number;
  }>({ phase: "idle", progress: 0 });
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentUploadIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const validProviderId = providerId?.length ? providerId : null;
  const sessionKey = providerId ?? importType;
  const initiateMutation = trpc.fileUpload.initiate.useMutation();
  const authorizePartsMutation = trpc.fileUpload.authorizeParts.useMutation();
  const completeMutation = trpc.fileUpload.complete.useMutation();
  const abortMutation = trpc.fileUpload.abort.useMutation();
  const trpcUtils = trpc.useUtils();

  const uploadApi = useMemo<FileUploadApi>(
    () => ({
      initiate: (input) => initiateMutation.mutateAsync(input),
      authorizeParts: (input) => authorizePartsMutation.mutateAsync(input),
      complete: (input) => completeMutation.mutateAsync(input),
      abort: (input) => abortMutation.mutateAsync(input),
      resume: (input) => trpcUtils.client.fileUpload.resume.query(input),
    }),
    [abortMutation, authorizePartsMutation, completeMutation, initiateMutation, trpcUtils],
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
    async (uploadId: string) => {
      currentUploadIdRef.current = uploadId;
      while (!stoppedRef.current) {
        const result = await uploadApi.resume({ uploadId });
        const upload = result.upload;
        if (upload.state === "completed") {
          setState({ phase: "completed", progress: 100, message: "Import completed" });
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
    [uploadApi, waitForNextPoll],
  );

  useEffect(() => {
    stoppedRef.current = false;
    void indexedDbUploadSessionStore.get(sessionKey).then((session) => {
      if (session && !stoppedRef.current) {
        currentUploadIdRef.current = session.uploadId;
        setState({
          phase: "cancelled",
          progress: 0,
          message: "Select the same file to resume upload",
        });
      }
    });
    const activeUploadId = activeImport ? uploadIdFromJobId(activeImport.jobId) : null;
    if (activeUploadId) void pollUpload(activeUploadId);
    return () => {
      stoppedRef.current = true;
      abortControllerRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [activeImport, pollUpload, sessionKey]);

  const uploadFile = useCallback(
    async (file: File) => {
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
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
          weightUnit,
          onProgress: (progress) =>
            setState({
              phase: progress.phase,
              progress: progress.percentage,
              message: progress.message,
            }),
        });
        currentUploadIdRef.current = completed.uploadId;
        setState({ phase: "processing", progress: 0, message: "Processing import..." });
        await pollUpload(completed.uploadId);
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
        abortControllerRef.current = null;
      }
    },
    [fullSync, importType, pollUpload, sessionKey, uploadApi, weightUnit],
  );

  const cancelUpload = useCallback(async () => {
    abortControllerRef.current?.abort();
    const uploadId = currentUploadIdRef.current;
    if (uploadId) {
      await uploadApi.abort({ uploadId });
      await indexedDbUploadSessionStore.delete(sessionKey);
    }
    setState({ phase: "cancelled", progress: 0, message: "Upload cancelled" });
  }, [sessionKey, uploadApi]);

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

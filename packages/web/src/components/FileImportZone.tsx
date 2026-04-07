import type { ProviderStats } from "@dofek/providers/provider-stats";
import { Link } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { formatTime } from "../lib/dates.ts";
import type { SyncLogEntry, SyncStatus } from "./DataSourcesSyncTypes.ts";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { ProviderStatsBreakdown } from "./ProviderStatsBreakdown.tsx";
import { StatusDot } from "./StatusDot.tsx";

export interface FileImportZoneProps {
  providerId?: string;
  title: string;
  description: string;
  accept: string;
  uploadUrl: string;
  statusUrl: string;
  chunked?: boolean;
  stats?: ProviderStats;
  recentLogs?: SyncLogEntry[];
}

export function FileImportZone({
  providerId,
  title,
  description,
  accept,
  uploadUrl,
  statusUrl,
  chunked,
  stats,
  recentLogs = [],
}: FileImportZoneProps) {
  const [state, setState] = useState<{ status: SyncStatus; progress?: number; message?: string }>({
    status: "idle",
  });
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pollStatus = useCallback(
    async (jobId: string) => {
      const poll = async (): Promise<void> => {
        try {
          const resp = await fetch(`${statusUrl}/${jobId}`);
          if (!resp.ok) throw new Error("Failed to get status");
          const data = await resp.json();

          if (data.status === "done") {
            setState({ status: "done", progress: 100, message: data.message });
            return;
          }
          if (data.status === "error") {
            setState({ status: "error", message: data.message ?? "Import failed" });
            return;
          }

          setState({
            status: "syncing",
            progress: data.progress ?? 0,
            message: data.message ?? "Processing...",
          });
          await new Promise((r) => setTimeout(r, 1000));
          return poll();
        } catch {
          setState({ status: "error", message: "Lost connection to server" });
        }
      };
      return poll();
    },
    [statusUrl],
  );

  const uploadFile = useCallback(
    async (file: File) => {
      setState({ status: "syncing", progress: 0, message: `Uploading ${file.name}...` });

      const MAX_RETRIES = 3;

      async function fetchWithRetry(
        url: string,
        init: RequestInit,
        attempt = 0,
      ): Promise<Response> {
        try {
          const resp = await fetch(url, init);
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: resp.statusText }));
            throw new Error(err.error ?? `Upload failed (HTTP ${resp.status})`);
          }
          return resp;
        } catch (err) {
          const isNetworkError =
            err instanceof TypeError ||
            (err instanceof Error && err.message.includes("NetworkError"));
          if (isNetworkError && attempt < MAX_RETRIES) {
            const delay = 1000 * 2 ** attempt;
            await new Promise((r) => setTimeout(r, delay));
            return fetchWithRetry(url, init, attempt + 1);
          }
          throw err;
        }
      }

      try {
        let jobId: string | null = null;

        if (chunked) {
          const CHUNK_SIZE = 50 * 1024 * 1024;
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
          const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const fileExt = file.name.endsWith(".xml") ? ".xml" : ".zip";

          for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            const uploadPct = Math.round(((i + 1) / totalChunks) * 50);
            setState({
              status: "syncing",
              progress: uploadPct,
              message:
                totalChunks > 1
                  ? `Uploading chunk ${i + 1}/${totalChunks}...`
                  : `Uploading ${file.name}...`,
            });

            const resp = await fetchWithRetry(uploadUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/octet-stream",
                "x-upload-id": uploadId,
                "x-chunk-index": String(i),
                "x-chunk-total": String(totalChunks),
                "x-file-ext": fileExt,
              },
              body: chunk,
            });
            const data = await resp.json();
            if (data.jobId) jobId = data.jobId;
          }
        } else {
          const resp = await fetchWithRetry(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: file,
          });
          const data = await resp.json();
          jobId = data.jobId ?? null;
        }

        if (jobId) {
          setState({ status: "syncing", progress: 50, message: "Processing import..." });
          await pollStatus(jobId);
        }
      } catch (err: unknown) {
        const message =
          err instanceof TypeError
            ? "Network error — check your connection and try again"
            : err instanceof Error
              ? err.message
              : "Upload failed";
        setState({ status: "error", message });
      }
    },
    [uploadUrl, chunked, pollStatus],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadFile(file);
    },
    [uploadFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    },
    [uploadFile],
  );

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        {providerId && <ProviderLogo provider={providerId} size={18} />}
        <StatusDot status={state.status} />
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <button
        type="button"
        tabIndex={0}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
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
        {state.status === "syncing" ? (
          <div>
            <div className="text-xs text-subtle">{state.message}</div>
            {state.progress != null && (
              <div className="mt-2 w-full h-1.5 rounded-full bg-accent/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${state.progress}%` }}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-dim">{description}</div>
        )}
      </button>
      {state.status !== "idle" && state.status !== "syncing" && (
        <div
          className={`mt-1.5 text-xs ${state.status === "error" ? "text-red-400" : "text-emerald-400"}`}
        >
          {state.message}
        </div>
      )}

      {/* Stats summary */}
      {stats && <ProviderStatsBreakdown stats={stats} />}

      {/* Recent sync dots + details link */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
        <div className="flex items-center gap-1">
          {recentLogs.map((l) => (
            <span
              key={`${l.syncedAt}-${l.status}-${l.recordCount}-${l.durationMs}`}
              className={`w-1.5 h-1.5 rounded-full ${
                l.status === "success" ? "bg-emerald-400" : "bg-red-400"
              }`}
              title={`${l.status} — ${formatTime(l.syncedAt)}`}
            />
          ))}
        </div>
        {providerId && (
          <Link
            to="/providers/$id"
            params={{ id: providerId }}
            className="text-xs text-dim hover:text-muted transition-colors"
          >
            Details
          </Link>
        )}
      </div>
    </div>
  );
}

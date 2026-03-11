import { useCallback, useRef, useState } from "react";
import { pollSyncJob } from "../lib/poll-sync-job.ts";
import { trpc } from "../lib/trpc.ts";

type SyncStatus = "idle" | "syncing" | "done" | "error";

interface ProviderState {
  status: SyncStatus;
  message?: string;
}

export function DataSourcesPanel() {
  const providers = trpc.sync.providers.useQuery();
  const syncMutation = trpc.sync.triggerSync.useMutation();
  const trpcUtils = trpc.useUtils();

  const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({});
  const [uploadState, setUploadState] = useState<{
    status: SyncStatus;
    progress?: number;
    message?: string;
  }>({ status: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateState = useCallback(
    (id: string, state: ProviderState) => setProviderStates((prev) => ({ ...prev, [id]: state })),
    [],
  );

  const doPollSyncJob = useCallback(
    (jobId: string, providerIds: string[]) =>
      pollSyncJob({
        jobId,
        providerIds,
        fetchStatus: (id) => trpcUtils.sync.syncStatus.fetch({ jobId: id }),
        updateState,
        onComplete: () => trpcUtils.sync.providers.invalidate(),
      }),
    [trpcUtils, updateState],
  );

  const handleSync = useCallback(
    async (providerId: string) => {
      updateState(providerId, { status: "syncing" });
      try {
        const { jobId } = await syncMutation.mutateAsync({ providerId, sinceDays: 7 });
        await doPollSyncJob(jobId, [providerId]);
      } catch (err: unknown) {
        updateState(providerId, {
          status: "error",
          message: err instanceof Error ? err.message : "Sync failed",
        });
      }
    },
    [syncMutation, updateState, doPollSyncJob],
  );

  const handleSyncAll = useCallback(async () => {
    const enabled = (providers.data ?? []).filter((p) => p.enabled);
    const ids = enabled.map((p) => p.id);
    for (const p of enabled) {
      updateState(p.id, { status: "syncing" });
    }
    try {
      const { jobId } = await syncMutation.mutateAsync({ sinceDays: 7 });
      await doPollSyncJob(jobId, ids);
    } catch (err: unknown) {
      for (const p of enabled) {
        updateState(p.id, {
          status: "error",
          message: err instanceof Error ? err.message : "Sync failed",
        });
      }
    }
  }, [providers.data, syncMutation, updateState, doPollSyncJob]);

  const pollUploadStatus = useCallback(async (jobId: string) => {
    const poll = async (): Promise<void> => {
      try {
        const resp = await fetch(`/api/upload/apple-health/status/${jobId}`);
        if (!resp.ok) throw new Error("Failed to get status");
        const data = await resp.json();

        if (data.status === "done") {
          setUploadState({ status: "done", progress: 100, message: data.message });
          return;
        }

        if (data.status === "error") {
          setUploadState({ status: "error", message: data.message ?? "Import failed" });
          return;
        }

        setUploadState({
          status: "syncing",
          progress: data.progress ?? 0,
          message: data.message ?? "Processing...",
        });

        await new Promise((r) => setTimeout(r, 1000));
        return poll();
      } catch {
        setUploadState({ status: "error", message: "Lost connection to server" });
      }
    };
    return poll();
  }, []);

  const uploadFile = useCallback(
    async (file: File) => {
      const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB to stay under Cloudflare's 100MB limit
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fileExt = file.name.endsWith(".xml") ? ".xml" : ".zip";

      setUploadState({
        status: "syncing",
        progress: 0,
        message: `Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(0)} MB)...`,
      });

      try {
        let jobId: string | null = null;

        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);

          const uploadPct = Math.round(((i + 1) / totalChunks) * 50);
          setUploadState({
            status: "syncing",
            progress: uploadPct,
            message:
              totalChunks > 1
                ? `Uploading chunk ${i + 1}/${totalChunks}...`
                : `Uploading ${file.name}...`,
          });

          const resp = await fetch("/api/upload/apple-health?fullSync=true", {
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

          if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: resp.statusText }));
            throw new Error(err.error ?? "Upload failed");
          }

          const data = await resp.json();
          if (data.jobId) jobId = data.jobId;
        }

        if (jobId) {
          setUploadState({ status: "syncing", progress: 50, message: "Processing import..." });
          await pollUploadStatus(jobId);
        }
      } catch (err: any) {
        setUploadState({ status: "error", message: err.message ?? "Upload failed" });
      }
    },
    [pollUploadStatus],
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

  const handleDropZoneKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  }, []);

  const enabledProviders = (providers.data ?? []).filter((p) => p.enabled);

  const handleProviderClick = useCallback(
    (p: { id: string; needsOAuth: boolean; authorized: boolean }) => {
      if (p.needsOAuth && !p.authorized) {
        // Open OAuth flow in new tab — will redirect back to /callback
        window.open(`/auth/${p.id}`, "_blank");
        return;
      }
      handleSync(p.id);
    },
    [handleSync],
  );

  return (
    <div className="space-y-6">
      {/* Provider Sync */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-zinc-300">Connected Providers</h3>
          {enabledProviders.length > 1 && (
            <button
              type="button"
              onClick={handleSyncAll}
              disabled={syncMutation.isPending}
              className="text-xs px-3 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition-colors"
            >
              Sync All
            </button>
          )}
        </div>

        {providers.isLoading ? (
          <div className="text-xs text-zinc-500">Loading providers...</div>
        ) : enabledProviders.length === 0 ? (
          <div className="text-xs text-zinc-500">
            No providers configured. Set API keys in .env to enable providers.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {enabledProviders.map((p) => {
              const state = providerStates[p.id] ?? { status: "idle" };
              const needsAuth = p.needsOAuth && !p.authorized;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleProviderClick(p)}
                  disabled={state.status === "syncing"}
                  className="flex flex-col items-start rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2.5 hover:bg-zinc-800 disabled:opacity-50 transition-colors"
                  title={needsAuth ? "Click to connect" : state.message}
                >
                  <div className="flex items-center gap-2">
                    {needsAuth ? (
                      <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
                    ) : (
                      <StatusDot status={state.status} />
                    )}
                    <span className="text-sm font-medium text-zinc-200">{p.name}</span>
                    {needsAuth && <span className="text-xs text-blue-400">Connect</span>}
                    {state.status === "syncing" && (
                      <span className="text-xs text-zinc-500">...</span>
                    )}
                  </div>
                  {state.message && state.status !== "syncing" && (
                    <span className="text-xs text-zinc-500 mt-0.5">{state.message}</span>
                  )}
                  {!state.message && p.lastSyncedAt && (
                    <span className="text-xs text-zinc-600 mt-0.5">
                      Last sync: {formatRelativeTime(p.lastSyncedAt)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Apple Health Upload */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Apple Health Import</h3>
        <div
          role="button"
          tabIndex={0}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={handleDropZoneKeyDown}
          className={`rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
            dragOver
              ? "border-blue-500 bg-blue-500/10"
              : "border-zinc-700 hover:border-zinc-600 bg-zinc-900/30"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.xml"
            onChange={handleFileSelect}
            className="hidden"
          />
          {uploadState.status === "syncing" ? (
            <div>
              <div className="text-sm text-zinc-300 mb-1">Importing...</div>
              <div className="text-xs text-zinc-500">{uploadState.message}</div>
              {uploadState.progress != null && (
                <div className="mt-2 w-48 mx-auto h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                    style={{ width: `${uploadState.progress}%` }}
                  />
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="text-sm text-zinc-400 mb-1">
                Drop Apple Health export here or click to browse
              </div>
              <div className="text-xs text-zinc-600">.zip or .xml from Health app export</div>
            </div>
          )}
        </div>
        {uploadState.status !== "idle" && uploadState.status !== "syncing" && (
          <div
            className={`mt-2 text-xs ${uploadState.status === "error" ? "text-red-400" : "text-emerald-400"}`}
          >
            {uploadState.message}
          </div>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StatusDot({ status }: { status: SyncStatus }) {
  const colors = {
    idle: "bg-zinc-600",
    syncing: "bg-amber-400 animate-pulse",
    done: "bg-emerald-400",
    error: "bg-red-400",
  };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status]}`} />;
}

import { useCallback, useRef, useState } from "react";
import { trpc } from "../lib/trpc.js";

type SyncStatus = "idle" | "syncing" | "done" | "error";

interface ProviderState {
  status: SyncStatus;
  message?: string;
}

export function DataSourcesPanel() {
  const providers = trpc.sync.providers.useQuery();
  const syncMutation = trpc.sync.triggerSync.useMutation();

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

  const handleSync = useCallback(
    async (providerId: string) => {
      updateState(providerId, { status: "syncing" });
      try {
        const result = await syncMutation.mutateAsync({ providerId, sinceDays: 7 });
        updateState(providerId, {
          status: "done",
          message: `${result.totalRecords} records, ${result.totalErrors} errors (${(result.duration / 1000).toFixed(1)}s)`,
        });
      } catch (err: any) {
        updateState(providerId, {
          status: "error",
          message: err.message ?? "Sync failed",
        });
      }
    },
    [syncMutation, updateState],
  );

  const handleSyncAll = useCallback(async () => {
    const enabled = (providers.data ?? []).filter((p) => p.enabled);
    for (const p of enabled) {
      updateState(p.id, { status: "syncing" });
    }
    try {
      const result = await syncMutation.mutateAsync({ sinceDays: 7 });
      for (const r of result.results) {
        updateState(r.provider, {
          status: r.errors.length > 0 ? "error" : "done",
          message: `${r.recordsSynced} records, ${r.errors.length} errors`,
        });
      }
    } catch (err: any) {
      for (const p of enabled) {
        updateState(p.id, { status: "error", message: err.message });
      }
    }
  }, [providers.data, syncMutation, updateState]);

  const uploadFile = useCallback(async (file: File) => {
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks to stay under Cloudflare's 100MB limit
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileExt = file.name.endsWith(".xml") ? ".xml" : ".zip";

    setUploadState({
      status: "syncing",
      progress: 0,
      message: `Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(0)} MB)...`,
    });

    try {
      let finalResult: any = null;

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const pct = Math.round(((i + 1) / totalChunks) * 100);
        setUploadState({
          status: "syncing",
          progress: pct,
          message:
            totalChunks > 1
              ? `Uploading chunk ${i + 1}/${totalChunks} (${pct}%)...`
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
        if (data.status !== "partial") {
          finalResult = data;
        }
      }

      if (finalResult) {
        setUploadState({
          status: "syncing",
          progress: 100,
          message: "Processing import...",
        });
        setUploadState({
          status: finalResult.errors?.length > 0 ? "error" : "done",
          message: `${finalResult.recordsSynced} records imported, ${finalResult.errors?.length ?? 0} errors (${(finalResult.duration / 1000).toFixed(1)}s)`,
        });
      }
    } catch (err: any) {
      setUploadState({ status: "error", message: err.message ?? "Upload failed" });
    }
  }, []);

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
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSync(p.id)}
                  disabled={state.status === "syncing"}
                  className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2.5 hover:bg-zinc-800 disabled:opacity-50 transition-colors"
                  title={state.message}
                >
                  <StatusDot status={state.status} />
                  <span className="text-sm font-medium text-zinc-200">{p.name}</span>
                  {state.status === "syncing" && <span className="text-xs text-zinc-500">...</span>}
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

function StatusDot({ status }: { status: SyncStatus }) {
  const colors = {
    idle: "bg-zinc-600",
    syncing: "bg-amber-400 animate-pulse",
    done: "bg-emerald-400",
    error: "bg-red-400",
  };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status]}`} />;
}

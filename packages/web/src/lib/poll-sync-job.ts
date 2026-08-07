export interface ProviderStatus {
  status: "pending" | "running" | "done" | "error";
  message?: string;
}

export interface SyncJobStatus {
  status: "queued" | "running" | "completed" | "failed";
  providers: Record<string, ProviderStatus>;
  percentage?: number;
  message?: string;
}

type SyncProviderState = {
  status: "syncing" | "done" | "error";
  message?: string;
  percentage?: number;
};

export interface PollSyncJobOptions {
  jobId: string;
  providerIds: string[];
  fetchStatus: (jobId: string) => Promise<SyncJobStatus | null>;
  updateState: (id: string, state: SyncProviderState) => void;
  onComplete: () => void;
  onError?: (error: unknown) => void;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function waitForNextPoll(pollIntervalMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (pollIntervalMs <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    const handleAbort = () => {
      clearTimeout(timeoutId);
      resolve(false);
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve(true);
    }, pollIntervalMs);
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

export async function pollSyncJob(opts: PollSyncJobOptions): Promise<void> {
  const {
    jobId,
    providerIds,
    fetchStatus,
    updateState,
    onComplete,
    onError,
    pollIntervalMs = 1000,
    signal,
  } = opts;
  const lastKnownProviderStates = new Map<string, SyncProviderState>();

  const resetSyncing = () => {
    for (const pid of providerIds) {
      if (signal?.aborted) return;
      updateState(pid, { status: "error", message: "Lost sync status" });
    }
  };

  const poll = async (): Promise<void> => {
    if (signal?.aborted) return;

    let job: SyncJobStatus | null;
    try {
      job = await fetchStatus(jobId);
    } catch (error: unknown) {
      if (signal?.aborted) return;
      onError?.(error);
      const message =
        error instanceof Error ? error.message : "Sync status is temporarily unavailable.";
      for (const providerId of providerIds) {
        if (signal?.aborted) return;
        const lastKnownState = lastKnownProviderStates.get(providerId) ?? { status: "syncing" };
        updateState(providerId, { ...lastKnownState, message });
      }
      if (!(await waitForNextPoll(pollIntervalMs, signal))) return;
      return poll();
    }

    if (signal?.aborted) return;
    if (!job) {
      resetSyncing();
      return;
    }

    for (const [pid, providerStatus] of Object.entries(job.providers)) {
      if (signal?.aborted) return;
      if (providerStatus.status === "done" || providerStatus.status === "error") {
        const providerState: SyncProviderState = {
          status: providerStatus.status === "done" ? "done" : "error",
          message: providerStatus.message ?? undefined,
        };
        lastKnownProviderStates.set(pid, providerState);
        updateState(pid, providerState);
      } else if (providerStatus.status === "running") {
        const providerState: SyncProviderState = {
          status: "syncing",
          message: providerStatus.message ?? "Syncing...",
          percentage: job.percentage,
        };
        lastKnownProviderStates.set(pid, providerState);
        updateState(pid, providerState);
      }
    }

    if (job.status === "completed" || job.status === "failed") {
      if (signal?.aborted) return;
      onComplete();
      return;
    }

    if (!(await waitForNextPoll(pollIntervalMs, signal))) return;
    return poll();
  };

  return poll();
}

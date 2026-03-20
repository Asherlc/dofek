export interface ProviderStatus {
  status: "pending" | "running" | "done" | "error";
  message?: string;
}

export interface SyncJobStatus {
  status: "running" | "done" | "error";
  providers: Record<string, ProviderStatus>;
  percentage?: number;
  message?: string;
}

export interface PollSyncJobOptions {
  jobId: string;
  providerIds: string[];
  fetchStatus: (jobId: string) => Promise<SyncJobStatus | null>;
  updateState: (
    id: string,
    state: { status: "syncing" | "done" | "error"; message?: string; percentage?: number },
  ) => void;
  onComplete: () => void;
  pollIntervalMs?: number;
}

export async function pollSyncJob(opts: PollSyncJobOptions): Promise<void> {
  const { jobId, providerIds, fetchStatus, updateState, onComplete, pollIntervalMs = 1000 } = opts;

  const resetSyncing = () => {
    for (const pid of providerIds) {
      updateState(pid, { status: "error", message: "Lost sync status" });
    }
  };

  const poll = async (): Promise<void> => {
    let job: SyncJobStatus | null;
    try {
      job = await fetchStatus(jobId);
    } catch {
      resetSyncing();
      return;
    }

    if (!job) {
      resetSyncing();
      return;
    }

    for (const [pid, providerStatus] of Object.entries(job.providers)) {
      if (providerStatus.status === "done" || providerStatus.status === "error") {
        updateState(pid, {
          status: providerStatus.status === "done" ? "done" : "error",
          message: providerStatus.message ?? undefined,
        });
      } else if (providerStatus.status === "running") {
        updateState(pid, {
          status: "syncing",
          message: providerStatus.message ?? "Syncing...",
          percentage: job.percentage,
        });
      }
    }

    if (job.status === "done" || job.status === "error") {
      onComplete();
      return;
    }

    if (pollIntervalMs > 0) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return poll();
  };

  return poll();
}

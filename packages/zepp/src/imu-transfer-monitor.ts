export interface ImuTransferTask {
  on(event: string, callback: (event: { data: Record<string, unknown> }) => void): void;
}

export interface ImuTransferMonitor {
  cancel(): void;
}

export const IMU_TRANSFER_TIMEOUT_MS = 120_000;

export function monitorImuTransfer(
  task: ImuTransferTask,
  options: {
    confirm(): Promise<void>;
    failureReason(data: Record<string, unknown>): string | null;
    onConfirmed(): void;
    onFailed(error: Error): void;
    timeoutMs?: number;
  },
): ImuTransferMonitor {
  let finished = false;
  const timer = setTimeout(() => {
    fail(new Error("IMU file transfer timed out."));
  }, options.timeoutMs ?? IMU_TRANSFER_TIMEOUT_MS);

  function finish(): boolean {
    if (finished) return false;
    finished = true;
    clearTimeout(timer);
    return true;
  }

  function fail(error: Error): void {
    if (!finish()) return;
    options.onFailed(error);
  }

  task.on("change", (event) => {
    if (finished) return;
    if (String(event.data.readyState) === "transferred") {
      void options
        .confirm()
        .then(() => {
          if (finish()) options.onConfirmed();
        })
        .catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      return;
    }
    const reason = options.failureReason(event.data);
    if (reason) fail(new Error(reason));
  });

  return {
    cancel() {
      finish();
    },
  };
}

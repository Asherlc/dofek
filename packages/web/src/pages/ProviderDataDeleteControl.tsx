import { useCallback, useEffect, useRef, useState } from "react";
import {
  OperationProgressBars,
  type OperationProgressItem,
} from "../components/OperationProgressBar.tsx";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export function ProviderDataDeleteControl({
  additionalOperations = [],
  providerId,
}: {
  additionalOperations?: readonly OperationProgressItem[];
  providerId: string;
}) {
  const trpcUtils = trpc.useUtils();
  const deleteAllDataMutation = trpc.providerDetail.deleteAllData.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const completionStarted = useRef(false);
  const deletionStatus = trpc.providerDetail.deletionStatus.useQuery(
    { providerId, operationId: operationId ?? "00000000-0000-0000-0000-000000000000" },
    {
      enabled: operationId !== null,
      refetchInterval: operationId === null ? false : 1000,
      staleTime: 0,
      meta: locallyReportedErrorMeta,
    },
  );

  const closeConfirm = useCallback(() => {
    setConfirmation("");
    setErrorMessage(null);
    setShowConfirm(false);
  }, []);

  const finishDeletion = useCallback(async () => {
    await Promise.all([
      trpcUtils.sync.providers.invalidate(),
      trpcUtils.sync.providerStats.invalidate(),
      trpcUtils.processing.status.invalidate(),
      trpcUtils.providerDetail.logs.invalidate({ providerId }),
      trpcUtils.providerDetail.records.invalidate({ providerId }),
    ]);
    setOperationId(null);
    closeConfirm();
    setSuccessMessage("Provider data deletion completed.");
  }, [closeConfirm, providerId, trpcUtils]);

  useEffect(() => {
    if (!operationId) return;
    if (deletionStatus.data?.status === "completed") {
      if (completionStarted.current) return;
      completionStarted.current = true;
      void finishDeletion().catch((error: unknown) => {
        captureException(error, { context: "provider-delete-finish" });
        setErrorMessage(error instanceof Error ? error.message : "Failed to refresh provider data");
        setOperationId(null);
      });
      return;
    }
    if (deletionStatus.data?.status === "failed") {
      setErrorMessage(deletionStatus.data.message ?? "Provider data deletion failed");
      setOperationId(null);
      return;
    }
    if (deletionStatus.error) {
      captureException(deletionStatus.error, { context: "provider-delete-status" });
      setErrorMessage(deletionStatus.error.message);
      setOperationId(null);
    }
  }, [deletionStatus.data, deletionStatus.error, finishDeletion, operationId]);

  const deleteAllData = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const result = await deleteAllDataMutation.mutateAsync({
        providerId,
        confirmation: "DELETE",
      });
      completionStarted.current = false;
      setOperationId(result.operationId);
    } catch (error: unknown) {
      captureException(error, { context: "provider-delete-all-data" });
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete provider data");
    }
  };

  const progressOperations: readonly OperationProgressItem[] = operationId
    ? [
        ...additionalOperations,
        {
          id: `provider-data-deletion-${operationId}`,
          label: "Provider data deletion",
          percentage: deletionStatus.data?.percentage,
          message: deletionStatus.data?.message ?? "Preparing provider data deletion...",
        },
      ]
    : additionalOperations;

  return (
    <section className="card border border-red-500/30 p-4 space-y-3">
      <div>
        <h2 className="text-sm font-medium text-red-400">Danger Zone</h2>
        <p className="text-xs text-subtle mt-1">
          Permanently delete every record from this provider. The provider will remain connected.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          setErrorMessage(null);
          setSuccessMessage(null);
          setShowConfirm(true);
        }}
        className="px-3 py-1.5 text-xs rounded border border-red-500/50 text-red-400 hover:bg-red-500/10 transition-colors"
      >
        Delete all data
      </button>
      {successMessage && <p className="text-xs text-emerald-400">{successMessage}</p>}

      {showConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-provider-data-title"
        >
          <form
            className="w-full max-w-md rounded-lg border border-red-500/40 bg-surface p-5 space-y-4 shadow-xl"
            onSubmit={(event) => {
              event.preventDefault();
              if (confirmation === "DELETE") void deleteAllData();
            }}
          >
            <div>
              <h2 id="delete-provider-data-title" className="text-base font-semibold text-red-400">
                {operationId ? "Deleting provider data..." : "Delete all provider data?"}
              </h2>
              {!operationId && (
                <p className="text-xs text-subtle mt-2">
                  This permanently deletes metric stream samples, activities, daily metrics, sleep,
                  nutrition, clinical records, and analytics derived from them. This cannot be
                  undone.
                </p>
              )}
            </div>
            {operationId ? (
              <OperationProgressBars operations={progressOperations} />
            ) : (
              <div>
                <label
                  htmlFor="delete-provider-confirmation"
                  className="block text-xs text-subtle mb-1"
                >
                  Type &quot;DELETE&quot; to confirm
                </label>
                <input
                  id="delete-provider-confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  className="w-full rounded border border-border-strong bg-accent/10 px-3 py-2 text-sm text-foreground focus:outline-none focus:border-red-500"
                />
              </div>
            )}
            {errorMessage && <p className="text-xs text-red-400">{errorMessage}</p>}
            {!operationId && (
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeConfirm}
                  disabled={deleteAllDataMutation.isPending}
                  className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={confirmation !== "DELETE" || deleteAllDataMutation.isPending}
                  className="px-3 py-1.5 text-xs rounded bg-red-600 text-white disabled:opacity-50"
                >
                  {deleteAllDataMutation.isPending ? "Deleting..." : "Permanently delete data"}
                </button>
              </div>
            )}
          </form>
        </div>
      )}
    </section>
  );
}

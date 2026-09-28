import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { captureException } from "../../../lib/telemetry.ts";
import { trpc } from "../../../lib/trpc.ts";

export function DeleteActivityButton({ activityId }: { activityId: string }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const navigate = useNavigate();
  const trpcUtils = trpc.useUtils();
  const deleteMutation = trpc.activity.delete.useMutation({
    onSuccess: () => {
      navigate({ to: "/dashboard" });
      void Promise.all([
        trpcUtils.activity.list.invalidate(),
        trpcUtils.calendar.weekList.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
      ]).catch((error: unknown) => {
        captureException(error, { context: "activity-delete-cache-invalidation" });
      });
    },
  });

  if (showConfirm) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Delete this activity? This cannot be undone.</span>
        <button
          type="button"
          onClick={() => deleteMutation.mutate({ id: activityId })}
          disabled={deleteMutation.isPending}
          className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-colors cursor-pointer"
        >
          {deleteMutation.isPending ? "Deleting..." : "Confirm Delete"}
        </button>
        <button
          type="button"
          onClick={() => setShowConfirm(false)}
          disabled={deleteMutation.isPending}
          className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
        >
          Cancel
        </button>
        {deleteMutation.error ? (
          <span role="alert" className="text-xs text-red-400">
            {userFacingErrorMessage(deleteMutation.error, "Unable to delete this activity.")}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setShowConfirm(true)}
      className="px-3 py-1.5 text-xs rounded bg-accent/10 text-red-400 hover:bg-surface-hover transition-colors cursor-pointer"
    >
      Delete Activity
    </button>
  );
}

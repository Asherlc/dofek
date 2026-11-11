import { formatDateTime } from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import {
  providerAbsentExplanation,
  providerLabel as providerName,
  providerSourceLabel,
} from "@dofek/providers/providers";
import { Link } from "@tanstack/react-router";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

type ProviderAbsentActivity = Pick<
  ActivityDetail,
  "id" | "providerId" | "subsource" | "providerAbsentAt"
>;

export function ProviderAbsentBanner({ activity }: { activity: ProviderAbsentActivity }) {
  const trpcUtils = trpc.useUtils();
  const providerLabel = providerSourceLabel(activity.providerId, activity.subsource);
  const remediationProviderLabel = providerName(activity.providerId);
  const restore = trpc.activity.restoreProviderAbsent.useMutation({
    meta: locallyReportedErrorMeta,
    onSuccess: async () => {
      await Promise.all([
        trpcUtils.activity.invalidate(),
        trpcUtils.calendar.weekListV2.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
        trpcUtils.calendar.calendarData.invalidate(),
      ]);
    },
    onError: (error) => captureException(error, { context: "activity-restore" }),
  });

  return (
    <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
      <div className="text-sm font-semibold text-amber-800 dark:text-amber-200">
        Removed from provider sync
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
            Status
          </dt>
          <dd className="mt-0.5 text-foreground">Removed</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
            Provider
          </dt>
          <dd className="mt-0.5 text-foreground">{providerLabel}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
            Removed at
          </dt>
          <dd className="mt-0.5 text-foreground">
            {activity.providerAbsentAt ? formatDateTime(activity.providerAbsentAt) : "—"}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-amber-800/80 dark:text-amber-200/80">
        {providerAbsentExplanation(activity.providerId, activity.subsource)}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="inline-flex rounded-md bg-amber-900 px-3 py-2 text-xs font-semibold text-white disabled:cursor-wait disabled:opacity-60 dark:bg-amber-100 dark:text-amber-950"
          disabled={restore.isPending}
          onClick={() => {
            restore.reset();
            restore.mutate({ ids: [activity.id] });
          }}
        >
          {restore.isPending ? "Restoring…" : "Restore activity"}
        </button>
        <Link
          to="/providers/$id"
          params={{ id: activity.providerId }}
          className="inline-flex text-xs font-semibold text-amber-900 underline decoration-amber-700/60 underline-offset-2 hover:text-amber-950 dark:text-amber-100 dark:hover:text-white"
        >
          Review {remediationProviderLabel} connection
        </Link>
      </div>
      {restore.error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {userFacingErrorMessage(restore.error, "Unable to restore this activity.")}
        </p>
      )}
    </div>
  );
}

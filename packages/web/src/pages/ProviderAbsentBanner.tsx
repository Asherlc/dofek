import { formatDateTime } from "@dofek/format/format";
import { providerAbsentExplanation, providerSourceLabel } from "@dofek/providers/providers";
import { Link } from "@tanstack/react-router";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";

type ProviderAbsentActivity = Pick<ActivityDetail, "providerId" | "subsource" | "providerAbsentAt">;

export function ProviderAbsentBanner({ activity }: { activity: ProviderAbsentActivity }) {
  const providerLabel = providerSourceLabel(activity.providerId, activity.subsource);

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
        {providerAbsentExplanation(activity.providerId, activity.subsource)} You can restore it from
        the activities page while showing hidden activities.
      </p>
      <Link
        to="/providers/$id"
        params={{ id: activity.providerId }}
        className="mt-3 inline-flex text-xs font-semibold text-amber-900 underline decoration-amber-700/60 underline-offset-2 hover:text-amber-950 dark:text-amber-100 dark:hover:text-white"
      >
        Review {providerLabel} connection
      </Link>
    </div>
  );
}

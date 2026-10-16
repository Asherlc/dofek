import { activityDataStateSchema } from "@dofek/format/activity-data-state";
import { formatDateYmd } from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { processingPollInterval } from "@dofek/providers/processing-status";
import { activityLocationSchema } from "dofek-server/activity-location";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useTrainingDays } from "../lib/trainingDaysContext.ts";
import { trpc } from "../lib/trpc.ts";
import { assertRows } from "../lib/utils.ts";
import { type Activity, ActivityList } from "./ActivityList.tsx";
import type { ActivityTableColumn } from "./ActivityTable.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const activityRowSchema = z.object({
  id: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  canonical_type: z.string(),
  name: z.string().nullable(),
  provider_id: z.string(),
  source_providers: z.array(z.string()).nullable(),
  distance_meters: z.number().nullable(),
  distance_state: activityDataStateSchema,
  elevation_gain_m: z.number().nullable(),
  elevation_state: activityDataStateSchema,
  location: activityLocationSchema.nullable().optional(),
});

const PAGE_SIZE = 20;

interface RecentActivitiesSectionProps {
  activityTypes?: readonly string[];
  additionalColumns?: Array<ActivityTableColumn<Activity>>;
  showDistance?: boolean;
  additionalDataLoading?: boolean;
  emptyMessage?: string;
}

export function RecentActivitiesSection({
  activityTypes,
  additionalColumns,
  showDistance,
  additionalDataLoading = false,
  emptyMessage,
}: RecentActivitiesSectionProps) {
  const { days } = useTrainingDays();
  const [page, setPage] = useState(0);
  const endDate = useMemo(() => formatDateYmd(new Date()), []);
  const trpcUtils = trpc.useUtils();

  const activities = trpc.activity.list.useQuery(
    {
      days,
      endDate,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      activityTypes: activityTypes ? [...activityTypes] : undefined,
    },
    {
      placeholderData: (previousData) => previousData,
      refetchInterval: (query) =>
        query.state.data?.items.some((activity) => activity.location?.kind === "processing")
          ? processingPollInterval("active")
          : false,
    },
  );
  const bulkDelete = trpc.activity.bulkDelete.useMutation({
    onSuccess: async () => {
      await Promise.all([
        trpcUtils.activity.list.invalidate(),
        trpcUtils.calendar.weekList.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
      ]);
    },
  });
  const items = assertRows(activities.data?.items, activityRowSchema);
  const hasCachedItems = items.length > 0;

  return (
    <>
      {activities.error && hasCachedItems ? (
        <QueryStatePanel error={activities.error} height={72} />
      ) : null}
      <ActivityList
        activities={items}
        additionalColumns={additionalColumns}
        showDistance={showDistance}
        loading={!hasCachedItems && (activities.isLoading || additionalDataLoading)}
        error={
          activities.error && !hasCachedItems
            ? userFacingErrorMessage(
                activities.error,
                "Activities could not be loaded. Please try again.",
              )
            : undefined
        }
        emptyMessage={emptyMessage}
        totalCount={activities.data?.totalCount}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        onBulkDelete={(ids) => {
          bulkDelete.mutate({ ids });
        }}
        bulkDeletePending={bulkDelete.isPending}
        bulkDeleteError={
          bulkDelete.error
            ? userFacingErrorMessage(
                bulkDelete.error,
                "The activities could not be deleted. Please try again.",
              )
            : undefined
        }
      />
    </>
  );
}

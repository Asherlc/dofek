import { activityDataStateSchema } from "@dofek/format/activity-data-state";
import { formatDateYmd } from "@dofek/format/format";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useTrainingDays } from "../lib/trainingDaysContext.ts";
import { trpc } from "../lib/trpc.ts";
import { assertRows } from "../lib/utils.ts";
import { type Activity, ActivityList } from "./ActivityList.tsx";
import type { ActivityTableColumn } from "./ActivityTable.tsx";

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
  location: z
    .object({
      centroidLat: z.number(),
      centroidLng: z.number(),
      mapPreview: z.object({
        width: z.number(),
        height: z.number(),
        tiles: z.array(
          z.object({
            url: z.string(),
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          }),
        ),
        routePath: z.array(z.object({ x: z.number(), y: z.number() })).nullable(),
      }),
    })
    .nullable()
    .optional(),
});

const PAGE_SIZE = 20;

interface RecentActivitiesSectionProps {
  activityTypes?: readonly string[];
  additionalColumns?: Array<ActivityTableColumn<Activity>>;
  additionalDataLoading?: boolean;
  emptyMessage?: string;
}

export function RecentActivitiesSection({
  activityTypes,
  additionalColumns,
  additionalDataLoading = false,
  emptyMessage,
}: RecentActivitiesSectionProps) {
  const { days } = useTrainingDays();
  const [page, setPage] = useState(0);
  const endDate = useMemo(() => formatDateYmd(new Date()), []);
  const trpcUtils = trpc.useUtils();

  const activities = trpc.activity.list.useQuery({
    days,
    endDate,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    activityTypes: activityTypes ? [...activityTypes] : undefined,
  });
  const bulkDelete = trpc.activity.bulkDelete.useMutation({
    onSuccess: async () => {
      await Promise.all([
        trpcUtils.activity.list.invalidate(),
        trpcUtils.calendar.weekList.invalidate(),
        trpcUtils.calendar.activityOverview.invalidate(),
      ]);
    },
  });

  return (
    <ActivityList
      activities={assertRows(activities.data?.items, activityRowSchema)}
      additionalColumns={additionalColumns}
      loading={activities.isLoading || additionalDataLoading}
      error={activities.error?.message}
      emptyMessage={emptyMessage}
      totalCount={activities.data?.totalCount}
      page={page}
      pageSize={PAGE_SIZE}
      onPageChange={setPage}
      onBulkDelete={(ids) => {
        bulkDelete.mutate({ ids });
      }}
      bulkDeletePending={bulkDelete.isPending}
      bulkDeleteError={bulkDelete.error?.message}
    />
  );
}

import { formatDateYmd } from "@dofek/format/format";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useTrainingDays } from "../lib/trainingDaysContext.ts";
import { trpc } from "../lib/trpc.ts";
import { assertRows } from "../lib/utils.ts";
import { ActivityList } from "./ActivityList.tsx";

const activityRowSchema = z.object({
  id: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  activity_type: z.string(),
  name: z.string().nullable(),
  provider_id: z.string(),
  source_providers: z.array(z.string()).nullable(),
  distance_meters: z.number().nullable().optional(),
  calories: z.number().nullable().optional(),
});

const PAGE_SIZE = 20;

interface RecentActivitiesSectionProps {
  activityTypes?: readonly string[];
}

export function RecentActivitiesSection({ activityTypes }: RecentActivitiesSectionProps) {
  const { days } = useTrainingDays();
  const [page, setPage] = useState(0);
  const endDate = useMemo(() => formatDateYmd(new Date()), []);

  const activities = trpc.activity.list.useQuery({
    days,
    endDate,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    activityTypes: activityTypes ? [...activityTypes] : undefined,
  });

  return (
    <ActivityList
      activities={assertRows(activities.data?.items, activityRowSchema)}
      loading={activities.isLoading}
      error={activities.error?.message}
      totalCount={activities.data?.totalCount}
      page={page}
      pageSize={PAGE_SIZE}
      onPageChange={setPage}
    />
  );
}

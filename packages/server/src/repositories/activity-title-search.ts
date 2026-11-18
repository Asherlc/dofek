import { TRPCError } from "@trpc/server";
import {
  type ActivitySearchIndex,
  activitySearchSortSchema,
} from "dofek/activity-search/opensearch";
import type { AccessWindow } from "../billing/entitlement.ts";
import { activitySearchCursor, pageActivitySearch } from "./activity-search-pagination.ts";

interface SearchInput {
  userId: string;
  timezone: string;
  accessWindow: AccessWindow;
  title: string;
  activityType?: string;
  cursor?: string;
  pageSize: number;
}

export async function searchActivityTitles<Activity extends { id: string }>(
  index: Pick<ActivitySearchIndex, "loadState" | "search">,
  hydrate: (ids: string[]) => Promise<Activity[]>,
  input: SearchInput,
): Promise<{ activities: Activity[]; next: string | null }> {
  const { userId, title, timezone, accessWindow, activityType, pageSize, cursor } = input;
  const codec = activitySearchCursor(activitySearchSortSchema, [
    userId,
    title,
    timezone,
    accessWindow,
    activityType,
  ]);
  const initialPosition = cursor ? await codec.decode(cursor) : undefined;
  if (!(await index.loadState()).ready) {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "Activity history is still being indexed. Try again later.",
    });
  }

  return pageActivitySearch({
    initialPosition,
    pageSize,
    encode: codec.encode,
    hydrate,
    load: async (after, limit) =>
      (await index.search({ userId, title, activityType, after, limit })).map(
        ({ activityId, sort }) => ({ id: activityId, position: sort }),
      ),
  });
}

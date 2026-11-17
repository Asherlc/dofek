import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  type ActivitySearchIndex,
  activitySearchSortSchema,
} from "dofek/activity-search/opensearch";
import {
  decryptCredentialValue,
  encryptCredentialValue,
  isEncryptedCredentialValue,
} from "dofek/security/credential-encryption";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";

export const activityTitleCursorSchema = z.string().max(2_048).refine(isEncryptedCredentialValue);
const maxBatchesPerPage = 8;

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
  const scope = createHash("sha256")
    .update(JSON.stringify([userId, title, timezone, accessWindow, activityType]))
    .digest("hex");
  const context = { tableName: "activity_search", columnName: "cursor", scopeId: scope };
  let after: z.infer<typeof activitySearchSortSchema> | undefined;
  if (cursor) {
    try {
      const token = activityTitleCursorSchema.parse(cursor);
      const serialized = await decryptCredentialValue(token, context);
      after = activitySearchSortSchema.parse(JSON.parse(serialized));
    } catch {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Search filters changed. Start a new search.",
      });
    }
  }
  if (!(await index.loadState()).ready) {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "Activity history is still being indexed. Try again later.",
    });
  }

  const limit = pageSize + 1;
  const activities: Activity[] = [];
  for (let batch = 0; batch < maxBatchesPerPage; batch++) {
    const hits = await index.search({ userId, title, activityType, after, limit });
    if (hits.length === 0) return { activities, next: null };
    const available = await hydrate(hits.map(({ activityId }) => activityId));
    const byId = new Map(available.map((activity) => [activity.id, activity]));
    for (const hit of hits) {
      const activity = byId.get(hit.activityId);
      if (activity) {
        if (activities.length === pageSize && after) {
          return { activities, next: await encryptCredentialValue(JSON.stringify(after), context) };
        }
        activities.push(activity);
      }
      after = hit.sort;
    }
    if (hits.length < limit) return { activities, next: null };
  }
  return {
    activities,
    next: after ? await encryptCredentialValue(JSON.stringify(after), context) : null,
  };
}

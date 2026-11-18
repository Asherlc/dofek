import { z } from "zod";
import { AccountErasureUserFencedError } from "../db/account-erasure.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  type ActivitySearchChange,
  type ActivitySearchCheckpoint,
  type ActivitySearchIndex,
  type ActivitySearchState,
  firstActivityId,
} from "./opensearch.ts";

const batchSize = 500;
const batchesPerPublication = 20;
const lastActivityId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const sourceSchema = z.object({
  version: z.string().regex(/^\d+$/),
  userId: z.uuid(),
  activityId: z.uuid(),
  title: z.string().trim().nullable(),
  activityType: z.string(),
  startedAt: z.iso.datetime(),
  searchable: z.boolean(),
});

export type ActivitySearchSource = z.infer<typeof sourceSchema>;

interface Publisher {
  assertActive(): Promise<void>;
  loadBatch(checkpoint?: ActivitySearchCheckpoint): Promise<ActivitySearchSource[]>;
  withWriteFence(userId: string, write: () => Promise<void>): Promise<void>;
  index: Pick<ActivitySearchIndex, "loadState"> & {
    saveState(state: ActivitySearchState): Promise<void>;
    applyChanges(changes: ActivitySearchChange[]): Promise<void>;
  };
}

export async function listChangedActivityTitles(
  client: Pick<ClickHouseClient, "query">,
  checkpoint?: ActivitySearchCheckpoint,
) {
  const boundary = checkpoint
    ? "WHERE (refresh_version, user_id, activity_id) > ({version:UInt64}, {userId:UUID}, {activityId:UUID})"
    : "";
  const response = await client.query({
    query: `SELECT toString(refresh_version) AS version, user_id AS userId,
        activity_id AS activityId, name AS title,
        coalesce(primary_canonical_type, canonical_type) AS activityType,
        formatDateTime(started_at, '%FT%T.%fZ', 'UTC') AS startedAt,
        toBool(is_deleted = 0 AND (ended_at IS NOT NULL OR coalesce(provider_type = 'climbing_log', false))) AS searchable
      FROM analytics.deduped_activities FINAL
      ${boundary}
      ORDER BY refresh_version, user_id, activity_id
      LIMIT {limit:UInt32}`,
    query_params: { ...checkpoint, limit: batchSize },
    format: "JSONEachRow",
    clickhouse_settings: { max_threads: 1 },
  });
  return z.array(sourceSchema).parse(await response.json());
}

function toChange(source: ActivitySearchSource): ActivitySearchChange {
  const { userId, activityId, title, activityType, startedAt, searchable } = source;
  if (!searchable || !title) return { kind: "delete", userId, activityId };
  return { kind: "index", activity: { userId, activityId, title, activityType, startedAt } };
}

export async function publishActivitySearchChanges(publisher: Publisher): Promise<void> {
  await publisher.assertActive();
  let state = await publisher.index.loadState();
  let after = state.checkpoint;
  for (let batchNumber = 0; batchNumber < batchesPerPublication; batchNumber++) {
    await publisher.assertActive();
    const batch = await publisher.loadBatch(after);
    const last = batch.at(-1);
    if (!last) {
      if (!state.ready || after !== state.checkpoint) {
        await publisher.index.saveState({
          ready: true,
          checkpoint: after && {
            version: after.version,
            userId: lastActivityId,
            activityId: lastActivityId,
          },
        });
      }
      return;
    }

    const changesByUser = new Map<string, ActivitySearchChange[]>();
    for (const source of batch) {
      const changes = changesByUser.get(source.userId) ?? [];
      changes.push(toChange(source));
      changesByUser.set(source.userId, changes);
    }
    const fencedUsers = new Set<string>();
    for (const [userId, changes] of changesByUser) {
      await publisher.assertActive();
      try {
        await publisher.withWriteFence(userId, () => publisher.index.applyChanges(changes));
      } catch (error) {
        if (!(error instanceof AccountErasureUserFencedError)) throw error;
        fencedUsers.add(userId);
      }
    }

    const finished = batch.length < batchSize;
    let safeBoundary = state.checkpoint?.version === last.version ? state.checkpoint : undefined;
    for (const row of batch) {
      if (row.version === last.version && !fencedUsers.has(row.userId)) safeBoundary = row;
    }
    after = { version: last.version, userId: last.userId, activityId: last.activityId };
    await publisher.assertActive();
    state = {
      checkpoint: {
        version: last.version,
        userId: finished ? lastActivityId : (safeBoundary?.userId ?? firstActivityId),
        activityId: finished ? lastActivityId : (safeBoundary?.activityId ?? firstActivityId),
      },
      ready: finished || state.ready,
    };
    await publisher.index.saveState(state);
    if (finished) return;
  }
}

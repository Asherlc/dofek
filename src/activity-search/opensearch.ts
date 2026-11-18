import { z } from "zod";

export const ACTIVITY_SEARCH_INDEX = "dofek-activity-search-v1";

export const activitySearchSortSchema = z.tuple([z.number(), z.number(), z.uuid()]);
type ActivitySearchSort = z.infer<typeof activitySearchSortSchema>;

const checkpointSchema = z.object({
  version: z.string().regex(/^\d+$/),
  userId: z.uuid(),
  activityId: z.uuid(),
});

const stateSchema = z.object({ checkpoint: checkpointSchema.optional(), ready: z.boolean() });
const stateDocumentSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), _source: z.object({ state: stateSchema }) }),
]);
const stateResultSchema = z.object({ docs: z.tuple([stateDocumentSchema]) });

export type ActivitySearchCheckpoint = z.infer<typeof checkpointSchema>;
export type ActivitySearchState = z.infer<typeof stateSchema>;

export interface ActivitySearchDocument {
  userId: string;
  activityId: string;
  title: string;
  activityType: string;
  startedAt: string;
}

export type ActivitySearchChange =
  | { kind: "index"; activity: ActivitySearchDocument }
  | { kind: "delete"; userId: string; activityId: string };

type RunMutation = <T>(request: (requestId: string) => Promise<T>) => Promise<T>;

const searchHitsSchema = z.object({
  hits: z.object({ hits: z.array(z.object({ sort: activitySearchSortSchema })) }),
});
const operationSchema = z.object({ status: z.number().int() });
const bulkResultSchema = z.object({
  items: z.array(
    z.union([z.object({ index: operationSchema }), z.object({ delete: operationSchema })]),
  ),
});
const eraseResultSchema = z.object({
  timed_out: z.boolean(),
  version_conflicts: z.number().int().nonnegative(),
  failures: z.array(z.unknown()),
});
const countResultSchema = z.object({
  hits: z.object({
    total: z.object({ value: z.number().int().nonnegative(), relation: z.literal("eq") }),
  }),
});
const shardResultSchema = z.object({ _shards: z.object({ failed: z.literal(0) }) });
const segmentStatsSchema = shardResultSchema.extend({
  _all: z.object({ primaries: z.object({ docs: z.object({ deleted: z.number().int() }) }) }),
});
const requestTimeoutMs = 30_000;
const stateId = "activity-search-state";
export const firstActivityId = "00000000-0000-0000-0000-000000000000";

interface ActivitySearchRequest {
  userId: string;
  title: string;
  activityType?: string;
  after?: ActivitySearchSort;
  limit: number;
}

function bulkLines(change: ActivitySearchChange): string[] {
  if (change.kind === "index") {
    return [
      JSON.stringify({ index: { _id: `${change.activity.userId}:${change.activity.activityId}` } }),
      JSON.stringify(change.activity),
    ];
  }
  return [JSON.stringify({ delete: { _id: `${change.userId}:${change.activityId}` } })];
}

export class ActivitySearchIndex {
  readonly #origin: string;
  readonly #authorization: string;

  constructor(uri: string) {
    const url = URL.parse(uri);
    if (url?.protocol !== "https:" || !url.username || !url.password) {
      throw new Error("Activity search requires an HTTPS service URL with credentials.");
    }
    this.#origin = url.origin;
    this.#authorization = `Basic ${Buffer.from(
      `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
    ).toString("base64")}`;
  }

  async #request(
    path: string,
    options: { method: string; body?: string; ndjson?: boolean },
    runMutation?: RunMutation,
  ): Promise<unknown> {
    const send = async (requestId?: string) => {
      const response = await fetch(`${this.#origin}/${ACTIVITY_SEARCH_INDEX}/${path}`, {
        method: options.method,
        body: options.body,
        headers: {
          authorization: this.#authorization,
          "content-type": options.ndjson ? "application/x-ndjson" : "application/json",
          ...(requestId ? { "x-opaque-id": requestId } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Activity search request failed with HTTP ${response.status}.`);
      }
      return response.json();
    };
    return runMutation ? runMutation(send) : send();
  }

  async search({ userId, title, activityType, after, limit }: ActivitySearchRequest) {
    const result = searchHitsSchema.parse(
      await this.#request("_search?allow_partial_search_results=false", {
        method: "POST",
        body: JSON.stringify({
          size: limit,
          _source: false,
          search_after: after,
          sort: [{ _score: "desc" }, { startedAt: "desc" }, { activityId: "asc" }],
          query: {
            bool: {
              filter: [{ term: { userId } }, ...(activityType ? [{ term: { activityType } }] : [])],
              should: [
                {
                  multi_match: {
                    query: title,
                    type: "bool_prefix",
                    operator: "and",
                    fields: ["title", "title._2gram", "title._3gram"],
                    boost: 3,
                  },
                },
                { match: { title: { query: title, operator: "and", fuzziness: "AUTO" } } },
              ],
              minimum_should_match: 1,
            },
          },
        }),
      }),
    );
    return result.hits.hits.map(({ sort }) => ({ activityId: sort[2], sort }));
  }

  async loadState(): Promise<ActivitySearchState> {
    const {
      docs: [document],
    } = stateResultSchema.parse(
      await this.#request("_mget", {
        method: "POST",
        body: JSON.stringify({ ids: [stateId] }),
      }),
    );
    return document.found ? document._source.state : { ready: false };
  }

  async saveState(state: ActivitySearchState, runMutation: RunMutation): Promise<void> {
    await this.#applyBulk(
      [JSON.stringify({ index: { _id: stateId } }), JSON.stringify({ state })],
      1,
      runMutation,
    );
  }

  async applyChanges(changes: ActivitySearchChange[], runMutation: RunMutation): Promise<void> {
    if (changes.length === 0) return;
    await this.#applyBulk(changes.flatMap(bulkLines), changes.length, runMutation);
  }

  async #applyBulk(lines: string[], operations: number, runMutation: RunMutation): Promise<void> {
    const data = bulkResultSchema.parse(
      await this.#request(
        "_bulk?refresh=wait_for",
        {
          method: "POST",
          body: `${lines.join("\n")}\n`,
          ndjson: true,
        },
        runMutation,
      ),
    );
    const complete =
      data.items.length === operations &&
      data.items.every((item) => {
        if ("delete" in item && item.delete.status === 404) return true;
        const operation = "index" in item ? item.index : item.delete;
        return operation.status >= 200 && operation.status < 300;
      });
    if (!complete) throw new Error("OpenSearch did not apply every activity update.");
  }

  async eraseAccount(userId: string, runMutation: RunMutation): Promise<void> {
    const result = eraseResultSchema.parse(
      await this.#request(
        "_delete_by_query?refresh=true",
        {
          method: "POST",
          body: JSON.stringify({ query: { term: { userId } } }),
        },
        runMutation,
      ),
    );
    if (result.timed_out || result.version_conflicts !== 0 || result.failures.length !== 0) {
      throw new Error("OpenSearch did not erase every activity.");
    }
    const resultCount = countResultSchema.parse(
      await this.#request("_search?allow_partial_search_results=false", {
        method: "POST",
        body: JSON.stringify({ size: 0, track_total_hits: true, query: { term: { userId } } }),
      }),
    );
    if (resultCount.hits.total.value !== 0)
      throw new Error("OpenSearch still contains activities for the erased account.");

    const state = await this.loadState();
    if (state.checkpoint?.userId === userId) {
      // Replay this version from its start so the cursor retains no erased IDs.
      await this.saveState(
        {
          ...state,
          checkpoint: {
            version: state.checkpoint.version,
            userId: firstActivityId,
            activityId: firstActivityId,
          },
        },
        runMutation,
      );
    }

    shardResultSchema.parse(
      await this.#request("_forcemerge?only_expunge_deletes=true", { method: "POST" }, runMutation),
    );
    const stats = segmentStatsSchema.parse(await this.#request("_stats/docs", { method: "GET" }));
    if (stats._all.primaries.docs.deleted !== 0)
      throw new Error("OpenSearch retains deleted activity segments.");
  }
}

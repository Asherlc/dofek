import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ActivitySearchIndex } from "./opensearch.ts";

const endpoint = "https://search.example.test";
const indexPath = `${endpoint}/dofek-activity-search-v1`;
const fixtureUsername = "fixture-reader";
const fixturePassword = randomUUID();
const userId = "a0000000-0000-4000-8000-000000000001";
const activityId = "a0000000-0000-4000-8000-000000000002";
const checkpoint = { version: "1794952647000000000", userId, activityId };
const activity = {
  userId,
  activityId,
  title: "Golden Hill Ride",
  activityType: "cycling",
  startedAt: "2021-05-14T15:00:00Z",
};
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function index() {
  const url = new URL(endpoint);
  url.username = fixtureUsername;
  url.password = fixturePassword;
  return new ActivitySearchIndex(url.href);
}

function runMutation<T>(request: (requestId: string) => Promise<T>) {
  return request("fixture-mutation");
}

describe("ActivitySearchIndex", () => {
  it("sends a scoped ranked prefix and fuzzy query and decodes its search-after values", async () => {
    const previous = [3.5, 1_700_000_000_000, activityId] satisfies [number, number, string];
    const next = [2.5, 1_600_000_000_000, activityId];
    server.use(
      http.post(`${indexPath}/_search`, async ({ request }) => {
        const fixtureCredentials = Buffer.from(`${fixtureUsername}:${fixturePassword}`);
        expect(request.headers.get("authorization")).toBe(
          `Basic ${fixtureCredentials.toString("base64")}`,
        );
        expect(await request.json()).toMatchObject({
          size: 20,
          _source: false,
          search_after: previous,
          sort: [{ _score: "desc" }, { startedAt: "desc" }, { activityId: "asc" }],
          query: {
            bool: {
              filter: [{ term: { userId } }, { term: { activityType: "cycling" } }],
              should: [
                {
                  multi_match: {
                    query: "golden hi",
                    type: "bool_prefix",
                    operator: "and",
                    boost: 3,
                  },
                },
                { match: { title: { query: "golden hi", operator: "and", fuzziness: "AUTO" } } },
              ],
              minimum_should_match: 1,
            },
          },
        });
        return HttpResponse.json({ hits: { hits: [{ sort: next }] } });
      }),
    );

    await expect(
      index().search({
        userId,
        title: "golden hi",
        activityType: "cycling",
        limit: 20,
        after: previous,
      }),
    ).resolves.toEqual([{ activityId, sort: next }]);
  });

  it("does not acknowledge a partially failed update and omits raw OpenSearch errors", async () => {
    server.use(
      http.post(`${indexPath}/_bulk`, async ({ request }) => {
        expect(request.headers.get("x-opaque-id")).toBe("fixture-mutation");
        expect(await request.text()).toBe(
          [
            JSON.stringify({ index: { _id: `${userId}:${activityId}` } }),
            JSON.stringify(activity),
            JSON.stringify({ delete: { _id: `${userId}:${activityId}` } }),
            "",
          ].join("\n"),
        );
        return HttpResponse.json({
          errors: true,
          items: [
            { index: { status: 429, error: { reason: activity.title } } },
            { delete: { status: 404 } },
          ],
        });
      }),
    );

    await expect(
      index().applyChanges(
        [
          { kind: "index", activity },
          { kind: "delete", userId, activityId },
        ],
        runMutation,
      ),
    ).rejects.toThrow(/^OpenSearch did not apply every activity update\.$/);
  });

  it("treats a replayed deletion of an absent activity as applied", async () => {
    server.use(
      http.post(`${indexPath}/_bulk`, () =>
        HttpResponse.json({ errors: false, items: [{ delete: { status: 404 } }] }),
      ),
    );
    await expect(
      index().applyChanges([{ kind: "delete", userId, activityId }], runMutation),
    ).resolves.toBeUndefined();
  });

  it("round trips the checkpoint and retains all digits of the ClickHouse version", async () => {
    const state = { checkpoint, ready: true };
    server.use(
      http.post(`${indexPath}/_bulk`, async ({ request }) => {
        expect(
          (await request.text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([{ index: { _id: "activity-search-state" } }, { state }]);
        return HttpResponse.json({ items: [{ index: { status: 200 } }] });
      }),
      http.post(`${indexPath}/_mget`, async ({ request }) => {
        expect(await request.json()).toEqual({ ids: ["activity-search-state"] });
        return HttpResponse.json({ docs: [{ found: true, _source: { state } }] });
      }),
    );

    await index().saveState(state, runMutation);
    await expect(index().loadState()).resolves.toEqual(state);
  });

  it("checks deletion in the account's documents and rejects a partial erase", async () => {
    server.use(
      http.post(`${indexPath}/_delete_by_query`, async ({ request }) => {
        expect(new URL(request.url).searchParams.get("refresh")).toBe("true");
        expect(await request.json()).toEqual({ query: { term: { userId } } });
        return HttpResponse.json({ timed_out: false, version_conflicts: 1, failures: [] });
      }),
    );

    await expect(index().eraseAccount(userId, runMutation)).rejects.toThrow(
      "OpenSearch did not erase every activity.",
    );
  });

  it.each([0, 1])(
    "checks stored segments after erasure (%i deleted documents)",
    async (deleted) => {
      server.use(
        http.post(`${indexPath}/_delete_by_query`, () =>
          HttpResponse.json({ timed_out: false, version_conflicts: 0, failures: [] }),
        ),
        http.post(`${indexPath}/_search`, async ({ request }) => {
          expect(await request.json()).toEqual({
            size: 0,
            track_total_hits: true,
            query: { term: { userId } },
          });
          return HttpResponse.json({ hits: { total: { value: 0, relation: "eq" } } });
        }),
        http.post(`${indexPath}/_mget`, () => HttpResponse.json({ docs: [{ found: false }] })),
        http.post(`${indexPath}/_forcemerge`, ({ request }) => {
          expect(new URL(request.url).searchParams.get("only_expunge_deletes")).toBe("true");
          return HttpResponse.json({ _shards: { failed: 0 } });
        }),
        http.get(`${indexPath}/_stats/docs`, () =>
          HttpResponse.json({ _shards: { failed: 0 }, _all: { primaries: { docs: { deleted } } } }),
        ),
      );

      if (deleted === 0) {
        await expect(index().eraseAccount(userId, runMutation)).resolves.toBeUndefined();
      } else {
        await expect(index().eraseAccount(userId, runMutation)).rejects.toThrow(
          "OpenSearch retains deleted activity segments.",
        );
      }
    },
  );

  it("removes the erased account from the backfill checkpoint before purging segments", async () => {
    let checkpointReplaced = false;
    server.use(
      http.post(`${indexPath}/_delete_by_query`, () =>
        HttpResponse.json({ timed_out: false, version_conflicts: 0, failures: [] }),
      ),
      http.post(`${indexPath}/_search`, () =>
        HttpResponse.json({ hits: { total: { value: 0, relation: "eq" } } }),
      ),
      http.post(`${indexPath}/_mget`, () =>
        HttpResponse.json({
          docs: [{ found: true, _source: { state: { checkpoint, ready: true } } }],
        }),
      ),
      http.post(`${indexPath}/_bulk`, async ({ request }) => {
        const body = await request.text();
        expect(body).not.toContain(userId);
        expect(body).not.toContain(activityId);
        expect(body).toContain(checkpoint.version);
        checkpointReplaced = true;
        return HttpResponse.json({ items: [{ index: { status: 200 } }] });
      }),
      http.post(`${indexPath}/_forcemerge`, () => {
        expect(checkpointReplaced).toBe(true);
        return HttpResponse.json({ _shards: { failed: 0 } });
      }),
      http.get(`${indexPath}/_stats/docs`, () =>
        HttpResponse.json({
          _shards: { failed: 0 },
          _all: { primaries: { docs: { deleted: 0 } } },
        }),
      ),
    );
    await expect(index().eraseAccount(userId, runMutation)).resolves.toBeUndefined();
  });
});

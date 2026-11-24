import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "./analytics-query-owner.ts";
import {
  drainGhostSessionHistory,
  runAnalyticsWithGhostHistory,
} from "./ghost-session-history-publication.ts";
import { runGhostSessionHistory } from "./ghost-session-history-runner.ts";

vi.mock("./ghost-session-history-runner.ts", () => ({ runGhostSessionHistory: vi.fn() }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

const ghostResource = { resourceId: "ghost-session-history", intentId: "ghost-session-history" };
const ordinaryIntent = "analytics-build";

describe("Ghost history publication isolation", () => {
  let context: TestContext;
  let client: ClickHouseClient;
  beforeAll(async () => {
    context = await setupTestDatabase();
    client = createClickHouseClientFromEnv();
  });
  beforeEach(async () => {
    await context.db.execute(sql`DELETE FROM fitness.analytics_query_owner
      WHERE resource_id IN (${ANALYTICS_PUBLICATION_RESOURCE}, ${ghostResource.resourceId})`);
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await client?.close?.();
    await context?.cleanup();
  });

  function state(resourceId: string) {
    return context.db.execute(sql`SELECT intent_id, quiescent, query_terminal
      FROM fitness.analytics_query_owner WHERE resource_id = ${resourceId}`);
  }

  it("releases ordinary publication before a terminal Ghost failure and admits erasure", async () => {
    let beforeGhost: Awaited<ReturnType<typeof state>> | undefined;
    vi.mocked(runGhostSessionHistory).mockImplementationOnce(async (owner) => {
      beforeGhost = await state(ANALYTICS_PUBLICATION_RESOURCE);
      await owner.client.command({ query: "SELECT throwIf(1)" });
      return { pendingTracks: 0, checkedAnchors: 0 };
    });
    await expect(
      runAnalyticsWithGhostHistory(context.db, client, ordinaryIntent, async (owner) => {
        await owner.client.query({ query: "SELECT 1", format: "JSONEachRow" });
      }),
    ).resolves.toBeUndefined();
    expect(beforeGhost).toMatchObject([{ intent_id: null, quiescent: true, query_terminal: true }]);
    expect(await state(ghostResource.resourceId)).toMatchObject([
      { intent_id: ghostResource.intentId, quiescent: true, query_terminal: true },
    ]);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: "ghost-session-history" },
    });
    await expect(drainGhostSessionHistory(context.db, client)).resolves.toBeUndefined();
    expect(await state(ghostResource.resourceId)).toMatchObject([
      { intent_id: null, quiescent: true, query_terminal: true },
    ]);
    await expect(
      withAnalyticsQueryOwner(
        context.db,
        client,
        { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: "account-erasure:fixture" },
        async () => {},
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps unknown Ghost liveness as an erasure barrier without retaining ordinary intent", async () => {
    const transport = vi
      .spyOn(client, "exec")
      .mockRejectedValueOnce(new Error("Ghost transport outcome is unknown"));
    vi.mocked(runGhostSessionHistory).mockImplementationOnce(async (owner) => {
      await owner.client.command({ query: "SELECT 1" });
      return { pendingTracks: 0, checkedAnchors: 0 };
    });
    await expect(
      runAnalyticsWithGhostHistory(context.db, client, "analytics-local-build", async () => {}),
    ).resolves.toBeUndefined();
    transport.mockRestore();
    expect(await state(ANALYTICS_PUBLICATION_RESOURCE)).toMatchObject([
      { intent_id: null, quiescent: true, query_terminal: true },
    ]);
    expect(await state(ghostResource.resourceId)).toMatchObject([
      { intent_id: ghostResource.intentId, quiescent: false, query_terminal: false },
    ]);
    await expect(drainGhostSessionHistory(context.db, client)).rejects.toThrow("BLOCKED");
  });
});

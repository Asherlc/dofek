import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ClickHouseError } from "@clickhouse/client";
import { sql } from "drizzle-orm";
import { HttpResponse, http, passthrough } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { withAnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import { createAnalyticsTestContext } from "../analytics/test-helpers.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";

describe("ClickHouse private input command HTTP boundary", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  const server = createIntegrationMswFixture();
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
    await context.clickhouse.command({
      query: "CREATE TABLE analytics.raw_input_http (n UInt64) ENGINE=MergeTree ORDER BY n",
    });
    server.activate({ onUnhandledFrame: "bypass" });
  });
  afterEach(() => server.resetHandlers());
  afterAll(async () => {
    server.deactivate();
    await context?.cleanup();
  });
  const inputQuery =
    "INSERT INTO analytics.raw_input_http SELECT n FROM input('n UInt64') FORMAT JSONEachRow";

  test("malformed input exception privacy is measured independently of query text", async () => {
    const queryId = randomUUID(),
      marker = `private-malformed-${randomUUID()}`;
    let failure: unknown;
    let sdkEcho = false;
    const expectedSdkError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const synthetic = args.some(
        (arg) => arg instanceof ClickHouseError && arg.message.includes(marker),
      );
      if (
        typeof args[0] === "string" &&
        args[0].includes("[@clickhouse/client][Connection]") &&
        synthetic
      ) {
        sdkEcho = true;
        return;
      }
      throw new Error("Unexpected error output during malformed-input privacy qualification");
    });
    try {
      await context.clickhouse.command({
        query: inputQuery,
        query_id: queryId,
        values: Readable.from([`${JSON.stringify({ n: marker })}\n`]),
      });
    } catch (error) {
      failure = error;
    } finally {
      expectedSdkError.mockRestore();
    }
    expect(failure instanceof ClickHouseError).toBe(true);
    await context.clickhouse.command({ query: "SYSTEM FLUSH LOGS" });
    const result = await context.clickhouse.query<{
      text_leaks: string;
      exception_leaks: string;
      rows: string;
    }>({
      query: `SELECT toString(count()) AS rows,toString(countIf(position(query,{marker:String})>0)) AS text_leaks,
        toString(countIf(position(exception,{marker:String})>0)) AS exception_leaks
        FROM system.query_log WHERE query_id={id:String} AND type='ExceptionWhileProcessing'`,
      query_params: { id: queryId, marker },
      format: "JSONEachRow",
    });
    const privacy = await result.json();
    process.stdout.write(
      `${JSON.stringify({
        qualification: "malformed-input-privacy",
        errorEcho: failure instanceof Error && failure.message.includes(marker),
        sdkEcho,
        logs: privacy,
      })}\n`,
    );
    // Exception/SDK echo is recorded as an unresolved privacy gate, not desired
    // behavior. Query-text separation and failure/no-write remain requirements.
    expect(privacy.map(({ rows, text_leaks }) => ({ rows, text_leaks }))).toEqual([
      { rows: "1", text_leaks: "0" },
    ]);
    const written = await context.clickhouse.query<{ count: string }>({
      query: "SELECT toString(count()) AS count FROM analytics.raw_input_http",
      format: "JSONEachRow",
    });
    expect(await written.json()).toEqual([{ count: "0" }]);
  });

  test("buffered late native SQL failure is official terminal error with pending intent", async () => {
    const resourceId = randomUUID(),
      intentId = randomUUID();
    let failure: unknown;
    try {
      await withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          await owner.client.command({
            query:
              "INSERT INTO analytics.raw_input_http SELECT n+toUInt64(throwIf(n=4096,'synthetic late input failure')) FROM input('n UInt64') FORMAT JSONEachRow",
            values: Readable.from([
              `${Array.from({ length: 5000 }, (_, n) => JSON.stringify({ n })).join("\n")}\n`,
            ]),
          });
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof ClickHouseError).toBe(true);
    const rows = await context.database.execute(
      sql`SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
    );
    const queryId = rows[0]?.query_id;
    expect(typeof queryId).toBe("string");
    expect(rows).toEqual([
      { intent_id: intentId, query_id: queryId, query_terminal: true, quiescent: true },
    ]);
    await context.clickhouse.command({ query: "SYSTEM FLUSH LOGS" });
    const evidence = await context.clickhouse.query<{ count: string; read: string }>({
      query:
        "SELECT toString(count()) AS count,toString(sum(read_rows)) AS read FROM system.query_log WHERE query_id={id:String} AND type='ExceptionWhileProcessing'",
      query_params: { id: queryId },
      format: "JSONEachRow",
    });
    const proof = await evidence.json();
    expect(proof[0]?.count).toBe("1");
    expect(Number(proof[0]?.read)).toBeGreaterThan(0);
  });

  test.each(["nonempty 200", "response stream failure", "lost response"])(
    "%s keeps the first owned ID pending and blocks continuation",
    async (mode) => {
      const resourceId = randomUUID(),
        intentId = randomUUID();
      let originalQueryId: string | null = null;
      let dispatched = 0;
      server.use(
        http.post("*", ({ request }) => {
          const url = new URL(request.url);
          if (!url.searchParams.get("query")?.includes("raw_input_http")) return passthrough();
          originalQueryId = url.searchParams.get("query_id");
          dispatched++;
          if (mode === "lost response") return HttpResponse.error();
          if (mode === "response stream failure")
            return new HttpResponse(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("synthetic private bytes"));
                  controller.error(new Error("synthetic truncated stream"));
                },
              }),
            );
          return HttpResponse.text("synthetic private late response body");
        }),
      );
      let caught: unknown;
      let continuation: unknown;
      await expect(
        withAnalyticsQueryOwner(
          context.database,
          context.clickhouse,
          { resourceId, intentId },
          async (owner) => {
            try {
              await owner.client.command({
                query: inputQuery,
                values: Readable.from(['{"n":1}\n']),
              });
            } catch (error) {
              caught = error;
            }
            try {
              await owner.client.command({ query: "SELECT 1" });
            } catch (error) {
              continuation = error;
            }
            return "swallowed input error";
          },
        ),
      ).rejects.toThrow("unknown request outcome");
      expect(caught instanceof Error).toBe(true);
      expect(caught instanceof ClickHouseError).toBe(false);
      expect(caught instanceof Error && caught.message.includes("private")).toBe(false);
      expect(
        continuation instanceof Error && continuation.message.includes("unknown request outcome"),
      ).toBe(true);
      expect(dispatched).toBe(1);
      expect(typeof originalQueryId).toBe("string");
      const rows = await context.database.execute(
        sql`SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
      );
      expect(rows).toEqual([
        { intent_id: intentId, query_id: originalQueryId, query_terminal: false, quiescent: false },
      ]);
      for (const replacement of [intentId, randomUUID()])
        await expect(
          withAnalyticsQueryOwner(
            context.database,
            context.clickhouse,
            { resourceId, intentId: replacement },
            async () => undefined,
          ),
        ).rejects.toThrow("verified recovery");
    },
  );
});

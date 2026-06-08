import { describe, expect, it, vi } from "vitest";
import {
  type CursorQueryClient,
  streamMetricStreamWindowViaCursor,
} from "./postgres-cursor-source.ts";

function makeRow(overrides: Record<string, unknown>) {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    recorded_at: new Date("2026-05-15T10:00:00.000Z"),
    recorded_at_cursor: "2026-05-15 10:00:00+00",
    user_id: "00000000-0000-0000-0000-000000000001",
    provider_id: "apple_health",
    external_id: "imu-1",
    device_id: "Apple Watch",
    source_type: "api",
    channel: "imu",
    activity_id: null,
    scalar: null,
    vector: [0.1, 0.2, 0.3],
    point: null,
    metadata: null,
    ...overrides,
  };
}

describe("streamMetricStreamWindowViaCursor", () => {
  it("opens one cursor, pages with FETCH, and yields parsed batches until empty", async () => {
    const calls: string[] = [];
    const pages = [
      [makeRow({ id: "10000000-0000-4000-8000-000000000001", external_id: "a" })],
      [makeRow({ id: "10000000-0000-4000-8000-000000000002", external_id: "b" })],
      [],
    ];
    let fetchIndex = 0;
    const client: CursorQueryClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text.split("\n")[0]?.trim() ?? text);
        if (text.startsWith("FETCH")) {
          return { rows: pages[fetchIndex++] ?? [] };
        }
        return { rows: [] };
      }),
    };

    const batches = [];
    for await (const batch of streamMetricStreamWindowViaCursor(client, {
      batchSize: 100000,
      start: new Date("2026-05-15T00:00:00.000Z"),
      end: new Date("2026-05-16T00:00:00.000Z"),
    })) {
      batches.push(batch);
    }

    // Two non-empty pages → two batches; third (empty) ends the loop.
    expect(batches).toHaveLength(2);
    expect(batches[0]?.rows[0]?.externalId).toBe("a");
    expect(batches[1]?.rows[0]?.externalId).toBe("b");
    expect(batches[1]?.cursor.recordedAt).toBe("2026-05-15 10:00:00+00");

    // Transaction framing: BEGIN, DECLARE (once), 3 FETCH, CLOSE, COMMIT.
    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]?.startsWith("DECLARE metric_stream_export NO SCROLL CURSOR")).toBe(true);
    expect(calls.filter((c) => c.startsWith("FETCH FORWARD 100000"))).toHaveLength(3);
    expect(calls).toContain("CLOSE metric_stream_export");
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("passes the window bounds as the cursor's bind parameters", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
    const client: CursorQueryClient = { query };

    const iterator = streamMetricStreamWindowViaCursor(client, {
      batchSize: 5000,
      start: new Date("2026-05-15T00:00:00.000Z"),
      end: new Date("2026-05-16T00:00:00.000Z"),
    });
    await iterator.next();

    const declareCall = query.mock.calls.find(([text]) => text.startsWith("DECLARE"));
    expect(declareCall?.[1]).toEqual(["2026-05-15T00:00:00.000Z", "2026-05-16T00:00:00.000Z"]);
  });
});

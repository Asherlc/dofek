import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createMetricStreamEvent, type MetricStreamRowInput } from "./events.ts";
import {
  buildMetricStreamArchiveObjects,
  compareMetricStreamEvents,
  MetricStreamArchiveChunker,
  type MetricStreamArchiveObject,
} from "./r2-export.ts";
import { parseMetricStreamArchiveObjectKey } from "./r2-replay.ts";

const ARCHIVE_TOPIC = "metric-stream-v1";

function decompressLines(body: Buffer): string[] {
  const text = gunzipSync(body).toString("utf8");
  return text.length === 0 ? [] : text.split("\n");
}

function recordedAtOf(line: string): string {
  const parsed: { recordedAt: string } = JSON.parse(line);
  return parsed.recordedAt;
}

function makeRow(overrides: Partial<MetricStreamRowInput>): MetricStreamRowInput {
  return {
    recordedAt: "2024-03-01T10:00:00.000Z",
    userId: "11111111-1111-4111-8111-111111111111",
    providerId: "wahoo",
    externalId: "ext-1",
    sourceType: "device",
    channel: "heart_rate",
    scalar: 120,
    ...overrides,
  };
}

describe("buildMetricStreamArchiveObjects", () => {
  it("produces lines byte-identical to the topic path's archived form", () => {
    // The Redpanda archive writes `JSON.stringify(event)` per line (producer
    // sends that value, r2-archive does `root = this`). The exporter must emit
    // the same bytes so its objects are interchangeable with the live path.
    const rows = [
      makeRow({ externalId: "a", recordedAt: "2024-03-01T10:00:01.000Z" }),
      makeRow({ externalId: "b", recordedAt: "2024-03-01T10:00:02.000Z", scalar: 121 }),
      makeRow({
        externalId: "c",
        recordedAt: "2024-03-01T10:00:03.000Z",
        channel: "power",
        scalar: 250,
      }),
    ];
    const events = rows.map(createMetricStreamEvent);

    const objects = buildMetricStreamArchiveObjects(events, {
      topic: ARCHIVE_TOPIC,
      partition: 0,
      maxObjectBytes: 10_000,
    });

    const archivedLines = objects.flatMap((object) => decompressLines(object.body));
    const expectedLines = events.map((event) => JSON.stringify(event));
    expect(archivedLines.slice().sort()).toEqual(expectedLines.slice().sort());
  });

  it("emits keys that the archive key parser accepts", () => {
    const events = [
      makeRow({ externalId: "a", recordedAt: "2024-03-01T10:15:00.000Z" }),
      makeRow({ externalId: "b", recordedAt: "2024-03-01T10:45:00.000Z" }),
    ].map(createMetricStreamEvent);

    const objects = buildMetricStreamArchiveObjects(events, {
      topic: ARCHIVE_TOPIC,
      partition: 0,
      maxObjectBytes: 10_000,
    });

    for (const object of objects) {
      expect(() => parseMetricStreamArchiveObjectKey(object.key)).not.toThrow();
      const parsed = parseMetricStreamArchiveObjectKey(object.key);
      expect(parsed.topic).toBe(ARCHIVE_TOPIC);
      expect(parsed.partition).toBe(0);
      // Every event in the object falls under the key's date/hour partition.
      for (const line of decompressLines(object.body)) {
        const recordedAt = recordedAtOf(line);
        expect(recordedAt.slice(0, 10)).toBe(parsed.date);
        expect(recordedAt.slice(11, 13)).toBe(parsed.hour);
      }
    }
  });

  it("buckets events into separate objects per (date, hour)", () => {
    const events = [
      makeRow({ externalId: "a", recordedAt: "2024-03-01T10:00:00.000Z" }),
      makeRow({ externalId: "b", recordedAt: "2024-03-01T11:00:00.000Z" }),
      makeRow({ externalId: "c", recordedAt: "2024-03-02T10:00:00.000Z" }),
    ].map(createMetricStreamEvent);

    const objects = buildMetricStreamArchiveObjects(events, {
      topic: ARCHIVE_TOPIC,
      partition: 0,
      maxObjectBytes: 10_000,
    });

    expect(objects).toHaveLength(3);
    expect(new Set(objects.map((object) => object.key)).size).toBe(3);
  });

  it("splits a single (date, hour) bucket once it exceeds maxObjectBytes", () => {
    const events = Array.from({ length: 6 }, (_, index) =>
      makeRow({
        externalId: `evt-${index}`,
        recordedAt: `2024-03-01T10:00:0${index}.000Z`,
      }),
    ).map(createMetricStreamEvent);
    const oneLineBytes = Buffer.byteLength(JSON.stringify(events[0]), "utf8");

    const objects = buildMetricStreamArchiveObjects(events, {
      topic: ARCHIVE_TOPIC,
      partition: 0,
      // Budget for ~2 lines per object.
      maxObjectBytes: oneLineBytes * 2 + 1,
    });

    expect(objects.length).toBeGreaterThan(1);
    for (const object of objects) {
      const bodyBytes = decompressLines(object.body).reduce(
        (sum, line, index) => sum + Buffer.byteLength(line, "utf8") + (index > 0 ? 1 : 0),
        0,
      );
      expect(bodyBytes).toBeLessThanOrEqual(oneLineBytes * 2 + 1);
    }
    // All events still archived exactly once.
    const archived = objects.flatMap((object) => decompressLines(object.body));
    expect(archived.slice().sort()).toEqual(
      events
        .map((event) => JSON.stringify(event))
        .slice()
        .sort(),
    );
  });

  it("gives a single over-budget event its own object rather than dropping it", () => {
    const big = createMetricStreamEvent(
      makeRow({
        externalId: "huge",
        recordedAt: "2024-03-01T10:00:00.000Z",
        vector: Array.from({ length: 500 }, (_, index) => index),
        scalar: null,
      }),
    );
    const objects = buildMetricStreamArchiveObjects([big], {
      topic: ARCHIVE_TOPIC,
      partition: 0,
      maxObjectBytes: 10,
    });
    expect(objects).toHaveLength(1);
    const [object] = objects;
    if (!object) {
      throw new Error("expected one archive object");
    }
    expect(decompressLines(object.body)).toEqual([JSON.stringify(big)]);
  });

  it("is deterministic: identical input yields identical keys and content", () => {
    const events = Array.from({ length: 20 }, (_, index) =>
      makeRow({
        externalId: `evt-${index}`,
        recordedAt: `2024-03-01T10:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    ).map(createMetricStreamEvent);
    const options = { topic: ARCHIVE_TOPIC, partition: 0, maxObjectBytes: 400 };

    const first = buildMetricStreamArchiveObjects(events, options);
    const second = buildMetricStreamArchiveObjects(events, options);

    expect(second.map((object) => object.key)).toEqual(first.map((object) => object.key));
    expect(second.map((object) => decompressLines(object.body))).toEqual(
      first.map((object) => decompressLines(object.body)),
    );
  });

  it("orders the bucket by (recordedAt, id) regardless of input order", () => {
    const events = [
      makeRow({ externalId: "later", recordedAt: "2024-03-01T10:00:09.000Z" }),
      makeRow({ externalId: "earlier", recordedAt: "2024-03-01T10:00:01.000Z" }),
    ].map(createMetricStreamEvent);

    const [object] = buildMetricStreamArchiveObjects(events, {
      topic: ARCHIVE_TOPIC,
      partition: 0,
      maxObjectBytes: 10_000,
    });
    if (!object) {
      throw new Error("expected one archive object");
    }

    const recordedAts = decompressLines(object.body).map(recordedAtOf);
    expect(recordedAts).toEqual([...recordedAts].sort());
  });

  it("streaming the chunker event-by-event matches the batch builder", () => {
    // The backfill script feeds ~423M rows through the chunker one at a time so
    // it never holds a whole hour in memory; the result must equal the in-memory
    // builder so the byte/key guarantees the tests above prove still hold.
    const events = Array.from({ length: 50 }, (_, index) =>
      makeRow({
        externalId: `evt-${index}`,
        // Span three hours across two days to exercise bucket transitions.
        recordedAt: new Date(
          Date.UTC(2024, 2, 1 + (index % 2), 10 + (index % 3), index % 60),
        ).toISOString(),
      }),
    ).map(createMetricStreamEvent);
    const options = { topic: ARCHIVE_TOPIC, partition: 0, maxObjectBytes: 350 };

    const batch = buildMetricStreamArchiveObjects(events, options);

    const chunker = new MetricStreamArchiveChunker(options);
    const streamed: MetricStreamArchiveObject[] = [];
    for (const event of [...events].sort(compareMetricStreamEvents)) {
      streamed.push(...chunker.push(event));
    }
    streamed.push(...chunker.flush());

    expect(streamed.map((object) => object.key)).toEqual(batch.map((object) => object.key));
    expect(streamed.map((object) => decompressLines(object.body))).toEqual(
      batch.map((object) => decompressLines(object.body)),
    );
  });
});

describe("compareMetricStreamEvents", () => {
  it("orders an earlier recordedAt before a later one (both directions)", () => {
    const earlier = createMetricStreamEvent(
      makeRow({ externalId: "e", recordedAt: "2024-03-01T10:00:00.000Z" }),
    );
    const later = createMetricStreamEvent(
      makeRow({ externalId: "l", recordedAt: "2024-03-01T10:00:01.000Z" }),
    );
    expect(compareMetricStreamEvents(earlier, later)).toBeLessThan(0);
    expect(compareMetricStreamEvents(later, earlier)).toBeGreaterThan(0);
  });

  it("breaks ties by id when recordedAt is equal (both directions)", () => {
    // Same recordedAt, different externalId → different deterministic ids.
    const left = createMetricStreamEvent(
      makeRow({ externalId: "aaa", recordedAt: "2024-03-01T10:00:00.000Z" }),
    );
    const right = createMetricStreamEvent(
      makeRow({ externalId: "bbb", recordedAt: "2024-03-01T10:00:00.000Z" }),
    );
    const [lower, higher] = left.id < right.id ? [left, right] : [right, left];
    expect(compareMetricStreamEvents(lower, higher)).toBeLessThan(0);
    expect(compareMetricStreamEvents(higher, lower)).toBeGreaterThan(0);
  });

  it("returns 0 when recordedAt and id are identical", () => {
    const event = createMetricStreamEvent(
      makeRow({ externalId: "x", recordedAt: "2024-03-01T10:00:00.000Z" }),
    );
    expect(compareMetricStreamEvents(event, { ...event })).toBe(0);
  });
});

describe("MetricStreamArchiveChunker", () => {
  const options = { topic: ARCHIVE_TOPIC, partition: 0, maxObjectBytes: 10_000 };

  it("emits no object for the first event of a bucket but flushes the prior bucket on a (date,hour) change", () => {
    const chunker = new MetricStreamArchiveChunker(options);
    const hour10 = createMetricStreamEvent(
      makeRow({ externalId: "a", recordedAt: "2024-03-01T10:30:00.000Z" }),
    );
    const hour11 = createMetricStreamEvent(
      makeRow({ externalId: "b", recordedAt: "2024-03-01T11:30:00.000Z" }),
    );

    expect(chunker.push(hour10)).toEqual([]);
    const completedOnHourChange = chunker.push(hour11);
    expect(completedOnHourChange).toHaveLength(1);
    expect(completedOnHourChange[0]?.key).toContain("date=2024-03-01/hour=10");

    const remaining = chunker.flush();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.key).toContain("date=2024-03-01/hour=11");
  });

  it("returns no objects when flushed without any events", () => {
    expect(new MetricStreamArchiveChunker(options).flush()).toEqual([]);
  });

  it("keys each object with its first and last index within the bucket", () => {
    const events = Array.from({ length: 4 }, (_, index) =>
      createMetricStreamEvent(
        makeRow({ externalId: `evt-${index}`, recordedAt: `2024-03-01T10:00:0${index}.000Z` }),
      ),
    );
    const oneLineBytes = Buffer.byteLength(JSON.stringify(events[0]), "utf8");
    // Budget for exactly two lines so the four events split 0-1 / 2-3.
    const objects = buildMetricStreamArchiveObjects(events, {
      ...options,
      maxObjectBytes: oneLineBytes * 2 + 1,
    });
    const indexRanges = objects.map((object) => {
      const parsed = parseMetricStreamArchiveObjectKey(object.key);
      return `${parsed.firstOffset}-${parsed.lastOffset}`;
    });
    expect(indexRanges).toEqual(["0-1", "2-3"]);
  });
});

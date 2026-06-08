import {
  METRIC_STREAM_BACKFILL_COLUMNS,
  type MetricStreamBackfillBatch,
  type MetricStreamBackfillWindow,
  parseMetricStreamBackfillRow,
} from "./postgres-backfill-source.ts";

/** Minimal Postgres client surface the cursor reader needs. */
export interface CursorQueryClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

const CURSOR_NAME = "metric_stream_export";

const CURSOR_SELECT = `SELECT ${METRIC_STREAM_BACKFILL_COLUMNS}
  FROM fitness.metric_stream
  WHERE recorded_at >= $1::timestamptz AND recorded_at < $2::timestamptz
  ORDER BY recorded_at ASC, id ASC`;

/**
 * Stream a [start, end) window through a server-side cursor.
 *
 * Postgres decompresses + sorts the matching (daily, compressed) chunk ONCE
 * when the cursor opens, then each `FETCH` streams a page from that sorted
 * result. Keyset pagination, by contrast, re-decompresses and re-sorts the whole
 * chunk on every batch — O(n²) within a dense chunk (a single 2026 IMU day is
 * ~5–10M rows and took ~14 min that way). `batchSize` bounds rows held in memory
 * per page; the caller should step the range one UTC day at a time so each
 * cursor's sort stays chunk-sized.
 */
export async function* streamMetricStreamWindowViaCursor(
  client: CursorQueryClient,
  window: MetricStreamBackfillWindow,
): AsyncGenerator<MetricStreamBackfillBatch> {
  await client.query("BEGIN");
  await client.query(`DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR ${CURSOR_SELECT}`, [
    window.start.toISOString(),
    window.end.toISOString(),
  ]);

  // batchSize is a validated positive integer (never user-supplied text), and
  // FETCH FORWARD cannot be parameterized, so inlining it is safe.
  const fetchSql = `FETCH FORWARD ${window.batchSize} FROM ${CURSOR_NAME}`;
  while (true) {
    const result = await client.query(fetchSql);
    if (result.rows.length === 0) {
      break;
    }
    const parsed = result.rows.map(parseMetricStreamBackfillRow);
    const lastRow = parsed[parsed.length - 1];
    if (!lastRow) {
      break;
    }
    yield { rows: parsed.map((row) => row.input), cursor: lastRow.cursor };
  }

  await client.query(`CLOSE ${CURSOR_NAME}`);
  await client.query("COMMIT");
}

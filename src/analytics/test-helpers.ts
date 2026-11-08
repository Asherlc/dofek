import { Readable } from "node:stream";
import type { createClient } from "@clickhouse/client";

export function completedExecResult(
  writtenRows: string,
  stream = Readable.from([]),
): Awaited<ReturnType<ReturnType<typeof createClient>["exec"]>> {
  return {
    stream,
    query_id: "fixture-query",
    response_headers: {},
    http_status_code: 200,
    summary: {
      written_rows: writtenRows,
      written_bytes: "0",
      read_rows: "0",
      read_bytes: "0",
      total_rows_to_read: "0",
      result_rows: "0",
      result_bytes: "0",
      elapsed_ns: "0",
    },
  };
}

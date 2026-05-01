import { describe, expect, it } from "vitest";
import {
  buildClickHousePeerStatement,
  buildMetricStreamMirrorStatement,
  buildPostgresPeerStatement,
} from "./clickhouse-cdc.ts";

describe("PeerDB ClickHouse CDC setup statements", () => {
  it("creates a Postgres peer for the app database", () => {
    expect(
      buildPostgresPeerStatement({
        peerName: "dofek_postgres",
        host: "db",
        port: 5432,
        user: "health",
        password: "secret",
        database: "health",
      }),
    ).toBe(`CREATE PEER IF NOT EXISTS dofek_postgres FROM POSTGRES WITH
(
  host = 'db',
  port = '5432',
  user = 'health',
  password = 'secret',
  database = 'health'
)`);
  });

  it("creates a ClickHouse peer using the native protocol port", () => {
    expect(
      buildClickHousePeerStatement({
        peerName: "dofek_clickhouse",
        host: "clickhouse",
        port: 9000,
        user: "default",
        password: "clickhouse-secret",
        database: "peerdb",
      }),
    ).toBe(`CREATE PEER IF NOT EXISTS dofek_clickhouse FROM CLICKHOUSE WITH
(
  host = 'clickhouse',
  port = 9000,
  user = 'default',
  password = 'clickhouse-secret',
  database = 'peerdb',
  disable_tls = true
)`);
  });

  it("creates a metric stream mirror that excludes columns not used by analytics", () => {
    expect(
      buildMetricStreamMirrorStatement({
        mirrorName: "dofek_metric_stream_cdc",
        sourcePeerName: "dofek_postgres",
        destinationPeerName: "dofek_clickhouse",
        publicationName: "peerdb_metric_stream_publication",
      }),
    ).toBe(`CREATE MIRROR IF NOT EXISTS dofek_metric_stream_cdc
FROM dofek_postgres TO dofek_clickhouse
WITH TABLE MAPPING
(
  {
    from: fitness.metric_stream,
    to: metric_stream,
    exclude: [device_id, source_type, vector]
  }
)
WITH (
  do_initial_copy = true,
  max_batch_size = 1000000,
  sync_interval = 60,
  publication_name = 'peerdb_metric_stream_publication',
  soft_delete = true
)`);
  });
});

import { sql } from "drizzle-orm";
import { z } from "zod";
import { EXPECTED_PEERDB_REPLICATION_SLOT_NAMES } from "../db/clickhouse-cdc-health.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "../db/typed-sql.ts";

import {
  assertNoActivePeerDbMirroredAccountRows,
  type PeerDbErasureIdentifiers,
  type PeerDbVerificationClickHouseClient,
} from "./peerdb-mirrored-rows.ts";

const postgresWalLsnSchema = z.string().regex(/^[0-9A-F]+\/[0-9A-F]+$/i);
const walBoundaryRowSchema = z.object({
  wal_lsn: postgresWalLsnSchema,
});
const replicationSlotRowSchema = z.object({
  active: z.boolean(),
  confirmed_flush_lsn: postgresWalLsnSchema.nullable(),
  reached_target: z.boolean(),
  slot_name: z.enum(EXPECTED_PEERDB_REPLICATION_SLOT_NAMES),
  wal_status: z.string().nullable(),
});

async function assertReplicationSlotsReachedBoundary(
  database: SchemaExecutionDatabase,
  walLsn: string,
): Promise<void> {
  const targetWalLsn = postgresWalLsnSchema.parse(walLsn);
  const slotNames = sql.join(
    EXPECTED_PEERDB_REPLICATION_SLOT_NAMES.map((slotName) => sql`${slotName}`),
    sql`, `,
  );
  const rows = await executeWithSchema(
    database,
    replicationSlotRowSchema,
    sql`SELECT
          slot_name,
          active,
          wal_status,
          confirmed_flush_lsn::text AS confirmed_flush_lsn,
          confirmed_flush_lsn >= ${targetWalLsn}::pg_lsn AS reached_target
        FROM pg_replication_slots
        WHERE slot_name IN (${slotNames})
        ORDER BY slot_name`,
  );
  const rowsBySlot = new Map(rows.map((row) => [row.slot_name, row]));
  for (const slotName of EXPECTED_PEERDB_REPLICATION_SLOT_NAMES) {
    const row = rowsBySlot.get(slotName);
    if (!row) {
      throw new Error(`PeerDB account-erasure proof is missing managed mirror slot ${slotName}`);
    }
    if (!row.active || row.wal_status === "lost" || !row.confirmed_flush_lsn) {
      throw new Error(
        `PeerDB managed mirror slot ${slotName} is not healthy for account-erasure proof`,
      );
    }
    if (!row.reached_target) {
      throw new Error(
        `PeerDB managed mirror slot ${slotName} has not flushed the account-erasure WAL boundary`,
      );
    }
  }
}

export async function captureAccountErasurePostgresWalLsn(
  database: SchemaExecutionDatabase,
): Promise<string> {
  const [row] = await executeWithSchema(
    database,
    walBoundaryRowSchema,
    sql`SELECT pg_current_wal_lsn()::text AS wal_lsn`,
  );
  if (!row) {
    throw new Error("Postgres did not return an account-erasure WAL boundary");
  }
  return row.wal_lsn;
}

export async function assertPeerDbAccountErasureDrained(
  database: SchemaExecutionDatabase,
  clickHouseClient: PeerDbVerificationClickHouseClient,
  walLsn: string,
  identifiers: PeerDbErasureIdentifiers,
): Promise<void> {
  await identifiers.store.assertClosureComplete("initial");
  if (!(await identifiers.store.loadPhysicalProgress("initial")))
    throw new Error("Account erasure physical preparation is incomplete");
  await assertReplicationSlotsReachedBoundary(database, walLsn);
  await assertNoActivePeerDbMirroredAccountRows(clickHouseClient, identifiers);
}

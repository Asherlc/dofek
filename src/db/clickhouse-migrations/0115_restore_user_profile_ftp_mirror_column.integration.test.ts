import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPostgresFitnessRawTableStatements } from "../clickhouse-raw-tables.ts";
import { createMigration as createMigration0108 } from "./0108_computed_cycling_power.ts";
import { clickHouseMigrations } from "./registry.ts";

describe("0115_restore_user_profile_ftp_mirror_column migration", () => {
  const database = `user_profile_ftp_${randomUUID().replaceAll("-", "")}`;
  const clickHouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickHouseUrl) throw new Error("CLICKHOUSE_URL is required");
  const client = createClient({ url: clickHouseUrl });
  const migration = clickHouseMigrations("postgres://test").find(
    ({ id }) => id === "0115_restore_user_profile_ftp_mirror_column",
  );
  if (!migration) throw new Error("Missing user profile FTP mirror migration");

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
  });

  it("restores the column on an existing mirror and accepts PeerDB's retained insert", async () => {
    await client.command({
      query: `CREATE TABLE ${database}.user_profile (
        id UUID, name String, email Nullable(String), birth_date Nullable(Date),
        max_hr Nullable(Int16), resting_hr Nullable(Int16), ftp Nullable(Int16), is_admin Bool,
        created_at DateTime64(6, 'UTC'), updated_at DateTime64(6, 'UTC'),
        _peerdb_synced_at DateTime64(9) DEFAULT now(), _peerdb_is_deleted Int8 DEFAULT 0,
        _peerdb_version Int64 DEFAULT 0
      ) ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY id`,
    });
    const existingProfileId = randomUUID();
    await client.command({
      query: `INSERT INTO ${database}.user_profile
        (id, name, is_admin, created_at, updated_at, ftp)
        VALUES ({id:UUID}, 'Existing fixture', false, now64(6), now64(6), 300)`,
      query_params: { id: existingProfileId },
    });
    const historicalFtpDrop = createMigration0108().statements.find(
      (statement) =>
        statement === "ALTER TABLE postgres_fitness.user_profile DROP COLUMN IF EXISTS ftp",
    );
    if (!historicalFtpDrop) throw new Error("Missing historical user profile FTP drop");
    await client.command({
      query: historicalFtpDrop.replaceAll("postgres_fitness.", `${database}.`),
    });

    for (const statement of migration.statements) {
      await client.command({
        query: statement.replaceAll("postgres_fitness.", `${database}.`),
      });
    }
    for (const statement of migration.statements) {
      await client.command({
        query: statement.replaceAll("postgres_fitness.", `${database}.`),
      });
    }

    const profileId = randomUUID();
    await client.command({
      query: `INSERT INTO ${database}.user_profile
        (id, name, is_admin, created_at, updated_at, ftp)
        VALUES ({id:UUID}, 'Mirror fixture', false, now64(6), now64(6), 250)`,
      query_params: { id: profileId },
    });
    const result = await client.query({
      query: `SELECT id, ftp FROM ${database}.user_profile FINAL ORDER BY id`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual(
      expect.arrayContaining([
        { id: existingProfileId, ftp: null },
        { id: profileId, ftp: 250 },
      ]),
    );
  });

  it("creates fresh canonical mirrors with ftp available to PeerDB", async () => {
    for (const statement of buildPostgresFitnessRawTableStatements()) {
      await client.command({
        query: statement.replaceAll("postgres_fitness.", `${database}.fresh_`),
      });
    }
    await client.command({
      query: `INSERT INTO ${database}.fresh_user_profile
        (id, name, is_admin, created_at, updated_at, ftp)
        VALUES ({id:UUID}, 'Fresh fixture', false, now64(6), now64(6), 275)`,
      query_params: { id: randomUUID() },
    });
    const result = await client.query({
      query: `SELECT ftp FROM ${database}.fresh_user_profile`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ ftp: 275 }]);
  });
});

import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPostgresFitnessRawTableStatements } from "../clickhouse-raw-tables.ts";
import { setupTestDatabase, type TestContext } from "../test-helpers.ts";
import { type PeerDbMirrorContract, peerDbMirrorContracts } from "./mirror-contracts.ts";
import {
  assertPeerDbMirrorSchemasCompatible,
  inspectPeerDbMirrorSchemas,
} from "./mirror-schema-validator.ts";

describe("PeerDB mirror schema compatibility", () => {
  const clickHouseDatabase = `peerdb_contract_${randomUUID().replaceAll("-", "")}`;
  let clickHouseClient: ReturnType<typeof createClient>;
  let postgresClient: Client;
  let testContext: TestContext;
  let contracts: readonly PeerDbMirrorContract[];

  beforeAll(async () => {
    const clickHouseUrl = process.env.CLICKHOUSE_URL?.trim();
    if (!clickHouseUrl) throw new Error("CLICKHOUSE_URL is required");
    testContext = await setupTestDatabase();
    postgresClient = new Client({ connectionString: testContext.connectionString });
    await postgresClient.connect();
    clickHouseClient = createClient({ url: clickHouseUrl });
    await clickHouseClient.command({ query: `CREATE DATABASE ${clickHouseDatabase}` });
    for (const statement of buildPostgresFitnessRawTableStatements()) {
      await clickHouseClient.command({
        query: statement.replaceAll("postgres_fitness.", `${clickHouseDatabase}.`),
      });
    }
    contracts = peerDbMirrorContracts.map((contract) => ({
      ...contract,
      destinationDatabase: clickHouseDatabase,
    }));
  });

  afterAll(async () => {
    await clickHouseClient?.command({
      query: `DROP DATABASE IF EXISTS ${clickHouseDatabase} SYNC`,
    });
    await clickHouseClient?.close();
    await postgresClient?.end();
    await testContext?.cleanup();
  });

  it("accepts the current PostgreSQL and ClickHouse schemas", async () => {
    await expect(
      assertPeerDbMirrorSchemasCompatible({
        clickHouseClient,
        contracts,
        sourcePostgresClient: postgresClient,
      }),
    ).resolves.toBeUndefined();
  });

  it("reproduces migration 0085 incompatibility when its exclusions are absent", async () => {
    await postgresClient.query(`ALTER TABLE fitness.daily_metrics
      ADD COLUMN stress_high_minutes integer,
      ADD COLUMN recovery_high_minutes integer,
      ADD COLUMN resilience_level text;
      ALTER TABLE fitness.sleep_session
      ADD COLUMN sleep_need_baseline_minutes integer,
      ADD COLUMN sleep_need_from_debt_minutes integer,
      ADD COLUMN sleep_need_from_strain_minutes integer,
      ADD COLUMN sleep_need_from_nap_minutes integer`);
    const oldContract = contracts.map((contract) => ({
      ...contract,
      tableMappings: contract.tableMappings.map((mapping) => ({
        ...mapping,
        exclude:
          mapping.sourceTableIdentifier === "fitness.daily_metrics" ||
          mapping.sourceTableIdentifier === "fitness.sleep_session"
            ? mapping.exclude.filter(
                (column) => !mapping.allowAbsentExcludedSourceColumns?.includes(column),
              )
            : mapping.exclude,
      })),
    }));

    const report = await inspectPeerDbMirrorSchemas({
      clickHouseClient,
      contracts: oldContract,
      sourcePostgresClient: postgresClient,
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          columns: ["recovery_high_minutes", "resilience_level", "stress_high_minutes"],
          kind: "missing_destination_columns",
          sourceTableIdentifier: "fitness.daily_metrics",
        }),
        expect.objectContaining({
          columns: [
            "sleep_need_baseline_minutes",
            "sleep_need_from_debt_minutes",
            "sleep_need_from_nap_minutes",
            "sleep_need_from_strain_minutes",
          ],
          kind: "missing_destination_columns",
          sourceTableIdentifier: "fitness.sleep_session",
        }),
      ]),
    );
  });
});

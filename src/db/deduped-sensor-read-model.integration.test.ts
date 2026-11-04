import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  seedInterleavedSensorResourceBackground,
  seedSensorResourceHistory,
  sensorResourceId,
  sensorResourceIds,
  sensorResourceKeys,
  sensorResourceRow,
  sensorResourceTime,
} from "./bounded-sensor-resource-test-helpers.ts";
import { BoundedSensorFixture, sensorRow, sensorUser } from "./bounded-sensor-test-helpers.ts";

const currentRawSchema = z.object({
  id: z.string(),
  activity_id: z.string().nullable(),
  user_id: z.string(),
  recorded_at: z.string(),
  channel: z.literal("heart_rate"),
  provider_id: z.enum(["reported", "fallback"]),
  external_id: z.string().nullable(),
  device_id: z.string().nullable(),
  source_type: z.string().nullable(),
  scalar: z.literal(222),
  metadata: z.string(),
  ingested_at: z.literal("2026-01-03 00:00:00.123456782"),
  version: z.literal("2"),
  is_deleted: z.union([z.literal(0), z.literal(1)]),
});
const measurementSchema = z.object({ measurement_kind: z.enum(["direct", "estimated"]) });

async function readCompleteAffectedKeyReference(fixture: BoundedSensorFixture, keys: number[]) {
  const scalarRows = [];
  const dedupRows = [];
  for (const key of keys) {
    // Reference-only: inspect every current fixture source at this key independently of dbt.
    // The fixture has exactly two fixed revisions, so revision 2 is its complete latest state.
    const raw = z.array(currentRawSchema).parse(
      await fixture.read(`/* reference-only, one complete key */
        SELECT id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
          device_id, source_type, scalar, metadata, ingested_at, version, is_deleted
        FROM ${fixture.database}.metric_stream
        WHERE user_id=toUUID('${sensorUser}') AND channel='heart_rate'
          AND recorded_at=toDateTime64('${sensorResourceTime(key)}', 6) AND version=2
        ORDER BY id`),
    );
    expect(raw).toHaveLength(400);
    expect(raw.map((row) => row.id)).toEqual(
      Array.from({ length: 400 }, (_, candidate) =>
        sensorResourceId(key + candidate * sensorResourceKeys),
      ),
    );
    const expectedScalars = raw.map((row) => ({
      id: row.id,
      activity_id: row.activity_id,
      member_activity_id: row.activity_id,
      user_id: row.user_id,
      recorded_at: row.recorded_at,
      recorded_date: "2026-01-01",
      channel: row.channel,
      provider_id: row.provider_id,
      source_external_id: row.external_id,
      device_id: row.device_id,
      source_type: row.source_type,
      measurement_kind: measurementSchema.parse(JSON.parse(row.metadata)).measurement_kind,
      scalar: row.scalar,
      provider_priority: row.provider_id === "reported" ? 1 : 2,
      _peerdb_synced_at: row.ingested_at,
      _peerdb_is_deleted: row.is_deleted,
      _peerdb_version: row.version,
    }));
    scalarRows.push(...expectedScalars);
    // Hand-derived winner: candidate zero has reported/direct priority and the smallest UUID.
    // The page references candidate 399, so the winner is outside the changed-source list.
    const winner = raw.find((row) => row.id === sensorResourceId(key));
    expect(winner).toMatchObject({ provider_id: "reported", scalar: 222 });
    if (!winner) throw new Error(`Reference fixture is missing winner for key ${key}`);
    expect(raw.every((row) => row.is_deleted === 1)).toBe(key === 999);
    dedupRows.push({
      user_id: sensorUser,
      recorded_at: sensorResourceTime(key),
      recorded_date: "2026-01-01",
      channel: "heart_rate",
      scalar: key === 999 ? null : 222,
      provider_id: key === 999 ? null : "reported",
      member_activity_id: key === 999 ? null : winner.activity_id,
      device_id: key === 999 ? null : winner.device_id,
      source_external_id: key === 999 ? null : winner.external_id,
      source_type: key === 999 ? null : winner.source_type,
      measurement_kind: key === 999 ? "unknown" : "direct",
      source_metric_stream_id: key === 999 ? null : winner.id,
      source_activity_id: key === 999 ? null : winner.activity_id,
      provider_priority: key === 999 ? 65535 : 1,
      source_refreshed_at: "2026-01-03 00:00:00.123456782",
      is_deleted: key === 999 ? 1 : 0,
      refreshed_at: "2026-01-03 00:00:00.123456782",
    });
  }
  scalarRows.sort(
    (left, right) =>
      left.recorded_at.localeCompare(right.recorded_at) ||
      left.provider_id.localeCompare(right.provider_id) ||
      left.id.localeCompare(right.id),
  );
  return { scalarRows, dedupRows };
}

async function readScaleCardinality(
  fixture: BoundedSensorFixture,
  table: "metric_stream" | "sensor_scalar_sample" | "source_placement",
) {
  const resultSchema = z.tuple([z.object({ value: z.string().regex(/^\d+$/) })]);
  const [rows] = resultSchema.parse(
    await fixture.read(`/* scale-verifier row count */
      SELECT count() AS value FROM ${fixture.database}.${table}`),
  );
  const counts = { versions: rows.value, source_ids: "0", keys: "0" };
  const sourceColumn = table === "source_placement" ? "source_id" : "id";
  for (const [field, column] of [
    ["source_ids", sourceColumn],
    ["keys", "recorded_at"],
  ] as const) {
    let distinct = 0n;
    for (let bucket = 0; bucket < 16; bucket++) {
      const [result] = resultSchema.parse(
        await fixture.read(`/* scale-verifier ${column} bucket ${bucket}/16 */
          SELECT uniqExact(${column}) AS value FROM ${fixture.database}.${table}
          WHERE cityHash64(toString(${column})) % 16 = ${bucket}`),
      );
      distinct += BigInt(result.value);
    }
    counts[field] = distinct.toString();
  }
  return counts;
}

async function compareCompleteResourcePage(
  fixture: BoundedSensorFixture,
  population: "original" | "interleaved",
): Promise<void> {
  const expectedCounts =
    population === "original"
      ? { versions: "800000", source_ids: "400000", keys: "1000" }
      : { versions: "3200000", source_ids: "1600000", keys: "4000" };
  if (population === "interleaved") {
    for (const table of ["metric_stream", "sensor_scalar_sample", "source_placement"] as const) {
      expect(await readScaleCardinality(fixture, table)).toEqual(expectedCounts);
    }
  } else {
    for (const table of ["metric_stream", "sensor_scalar_sample"]) {
      expect(
        await fixture.read(`SELECT count() AS versions, uniqExact(id) AS source_ids,
          uniqExact(recorded_at) AS keys FROM ${fixture.database}.${table}`),
      ).toEqual([expectedCounts]);
    }
    expect(
      await fixture.read(`SELECT count() AS versions, uniqExact(source_id) AS source_ids,
        uniqExact(recorded_at) AS keys FROM ${fixture.database}.source_placement`),
    ).toEqual([expectedCounts]);
  }
  const activeParts =
    population === "interleaved"
      ? await fixture.read(`SELECT table, partition, count() AS active_parts,
          sum(rows) AS physical_rows, sum(bytes_on_disk) AS bytes_on_disk
        FROM system.parts WHERE active AND database='${fixture.database}'
          AND table IN ('metric_stream', 'source_placement', 'sensor_scalar_sample')
        GROUP BY table, partition ORDER BY table, partition`)
      : [];
  const keys = [...Array.from({ length: 19 }, (_, index) => index), 999];
  const reference = await readCompleteAffectedKeyReference(fixture, keys);
  const effects = keys.map((key) => {
    const changedIndex = key + sensorResourceIds - sensorResourceKeys;
    return {
      before: sensorResourceRow(changedIndex, 1),
      after: sensorResourceRow(changedIndex, 2),
    };
  });
  await fixture.page(effects, "3", "pulsar");
  const captured = await fixture.capture("scalar");
  expect(captured).toMatchObject({ next: { effectOrdinal: "19" }, exhausted: true });
  expect(captured.vars).toEqual({
    analytics_source_ids: effects.map((effect) => effect.after.id),
    analytics_keys: keys.map((key) => ({
      userId: sensorUser,
      channel: "heart_rate",
      recordedAt: `${sensorResourceTime(key).replace(" ", "T")}Z`,
    })),
    analytics_publication_revision: "3",
  });
  const evidencePath = join(dirname(fixture.evidencePath), "resource-page.json");
  writeFileSync(
    evidencePath,
    JSON.stringify({ population, expectedCounts, activeParts, captured, keys, reference }, null, 2),
  );

  await fixture.scalar();
  const scalarRows = await fixture.read(`SELECT * EXCEPT(refresh_version)
    FROM ${fixture.database}.sensor_scalar_sample WHERE refresh_version=3
    ORDER BY user_id, channel, recorded_at, provider_id, id`);
  expect(scalarRows).toEqual(reference.scalarRows);
  const dedupRows = await fixture.dedup();
  expect(dedupRows).toEqual(reference.dedupRows);
  writeFileSync(
    evidencePath,
    JSON.stringify(
      { population, expectedCounts, activeParts, captured, keys, reference, scalarRows, dedupRows },
      null,
      2,
    ),
  );
  // One page over unchanged complete affected-key populations, not a full-table publication.
}

describe("canonical dedup attribution", () => {
  let fixture: BoundedSensorFixture;
  beforeAll(async () => {
    fixture = new BoundedSensorFixture();
    await fixture.create();
  });
  afterAll(async () => {
    await fixture.close();
  });
  it("selects one complete provider row while preserving nullable provenance", async () => {
    const winner = sensorRow(1);
    const competitor = sensorRow(2, {
      provider_id: "fallback",
      activity_id: sensorResourceId(500),
      external_id: "other",
      device_id: "other",
      source_type: "activity",
      scalar: 222,
      metadata: '{"measurement_kind":"estimated"}',
      ingested_at: "2026-01-02 00:00:00.123456782",
    });
    await fixture.seed([winner, competitor]);
    await fixture.page([{ before: null, after: competitor }]);
    await fixture.scalar();
    expect(await fixture.dedup()).toEqual([
      {
        user_id: sensorUser,
        recorded_at: winner.recorded_at,
        recorded_date: "2026-01-01",
        channel: "heart_rate",
        scalar: 115,
        provider_id: "reported",
        member_activity_id: null,
        device_id: null,
        source_external_id: null,
        source_type: null,
        measurement_kind: "direct",
        source_metric_stream_id: winner.id,
        source_activity_id: null,
        provider_priority: 1,
        source_refreshed_at: competitor.ingested_at,
        is_deleted: 0,
        refreshed_at: competitor.ingested_at,
      },
    ]);
  });
});

describe("canonical sensor pathological key resource gate", () => {
  let fixture: BoundedSensorFixture;
  beforeAll(async () => {
    fixture = new BoundedSensorFixture();
    await fixture.create();
    await seedSensorResourceHistory(fixture, "pathological");
  }, 120_000);
  afterAll(async () => {
    await fixture.close();
  });

  it("pathologicalCompleteKeyFailsWithinFixedMemoryBudget", async () => {
    expect(
      await fixture.read(`SELECT count() AS versions, uniqExact(id) AS source_ids,
        uniqExact(recorded_at) AS keys FROM ${fixture.database}.metric_stream`),
    ).toEqual([{ versions: "800000", source_ids: "400000", keys: "1" }]);
    expect(
      await fixture.read(`SELECT count() AS versions, uniqExact(source_id) AS source_ids,
        uniqExact(recorded_at) AS keys FROM ${fixture.database}.source_placement`),
    ).toEqual([{ versions: "800000", source_ids: "400000", keys: "1" }]);
    const effects = Array.from({ length: 20 }, (_, index) => ({
      before: sensorResourceRow(index, 1, 1),
      after: sensorResourceRow(index, 2, 1),
    }));
    await fixture.page(effects, "3", "pulsar");
    const captured = await fixture.capture("scalar");
    expect(captured).toMatchObject({ next: { effectOrdinal: "19" }, exhausted: true });
    expect(captured.vars.analytics_source_ids).toHaveLength(20);
    expect(captured.vars.analytics_keys).toHaveLength(1);
    const beforeHealth = await fixture.read("SELECT uptime() AS uptime, version() AS version");
    const outputQuery = `SELECT
      (SELECT count() FROM ${fixture.database}.sensor_scalar_sample) AS scalar_rows,
      (SELECT count() FROM ${fixture.database}.deduped_sensor) AS dedup_rows`;
    const beforeOutput = await fixture.read(outputQuery);
    expect(beforeOutput).toEqual([{ scalar_rows: "0", dedup_rows: "0" }]);
    const evidencePath = join(dirname(fixture.evidencePath), "pathological-page.json");
    const identity = {
      database: fixture.database,
      targets: [`${fixture.database}.sensor_scalar_sample`, `${fixture.database}.deduped_sensor`],
      publicationRevision: captured.vars.analytics_publication_revision,
    };
    writeFileSync(
      evidencePath,
      JSON.stringify({ identity, captured, beforeHealth, beforeOutput }, null, 2),
    );

    await expect(fixture.scalar()).rejects.toMatchObject({ code: "241" });

    const modelRequest = fixture.requests
      .filter(
        (request) =>
          request.sql.startsWith("INSERT INTO") && request.sql.includes("sensor_scalar_sample"),
      )
      .at(-1);
    expect(modelRequest).toMatchObject({ state: "terminal-error", code: "241" });
    const afterHealth = await fixture.read("SELECT uptime() AS uptime, version() AS version");
    const afterOutput = await fixture.read(outputQuery);
    const afterCaptured = await fixture.capture("scalar");
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          identity,
          captured,
          beforeHealth,
          beforeOutput,
          modelRequest,
          afterHealth,
          afterOutput,
          afterCaptured,
        },
        null,
        2,
      ),
    );
    expect(afterOutput).toEqual(beforeOutput);
    expect(afterCaptured).toEqual(captured);
    expect(afterHealth).toEqual([expect.objectContaining({ version: beforeHealth[0]?.version })]);
    expect(Number(afterHealth[0]?.uptime)).toBeGreaterThanOrEqual(Number(beforeHealth[0]?.uptime));
    // Root must also verify the authoritative process identity and own-query log exception.
    // Actual durable no-checkpoint proof belongs to Task 5's real executor, never a fixture counter.
  }, 120_000);
});

describe("canonical sensor distributed resource gate", () => {
  let fixture: BoundedSensorFixture;
  beforeAll(async () => {
    fixture = new BoundedSensorFixture();
    await fixture.create();
    await seedSensorResourceHistory(fixture, "distributed");
  }, 120_000);
  afterAll(async () => {
    await fixture.close();
  });

  it("boundedCanonicalPageMatchesCompleteAffectedKeyReference", async () => {
    await compareCompleteResourcePage(fixture, "original");
  }, 120_000);
});

describe("canonical sensor unrelated background IO scale check", () => {
  let fixture: BoundedSensorFixture;
  beforeAll(async () => {
    fixture = new BoundedSensorFixture();
    await fixture.create();
    await seedSensorResourceHistory(fixture, "distributed");
    await seedInterleavedSensorResourceBackground(fixture);
  }, 120_000);
  afterAll(async () => {
    await fixture.close();
  });

  it("unchangedPageWithInterleavedUnrelatedBackground", async () => {
    await compareCompleteResourcePage(fixture, "interleaved");
  }, 120_000);
});

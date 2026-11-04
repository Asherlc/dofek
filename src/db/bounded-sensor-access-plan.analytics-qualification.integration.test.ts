import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { BoundedSensorFixture, sensorRow, sensorUser } from "./bounded-sensor-test-helpers.ts";

const sourceIds = 1_600_000;
const bulkIds = sourceIds - 41 - 60;
const leftIds = Math.floor(bulkIds / 2);
const batchRows = 10_000;
const linkedActivity = "20000000-0000-4000-8000-000000000001";
const ingestion = ["2026-02-01 00:00:00.123456781", "2026-02-02 00:00:00.123456782"];
const expectedMarks = {
  matchingPerPart: 2,
  neighborsPerPart: 2,
  overlappingParts: 4,
  selectedPerRead: 16,
  fullyMergedMinimum: Math.ceil(sourceIds / 8192),
  minimumRatio: Math.ceil(sourceIds / 8192) / 16,
};
const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const time = (microseconds: number) =>
  `2026-01-15 12:00:00.${String(microseconds).padStart(6, "0")}`;

function smallRow(source: number, microseconds: number, version: 1 | 2) {
  return sensorRow(1, {
    id: id(source),
    activity_id: source % 2 === 0 ? linkedActivity : null,
    recorded_at: time(microseconds),
    scalar: version * 111,
    version: String(version),
    ingested_at: ingestion[version - 1],
  });
}

async function loadInput(fixture: BoundedSensorFixture): Promise<void> {
  const small = ([1, 2] as const).flatMap((version) => [
    ...Array.from({ length: 40 }, (_, index) => smallRow(index + 1, (index % 20) * 1000, version)),
    smallRow(41, version === 1 ? 0 : 50_000, version),
    ...Array.from({ length: 60 }, (_, index) =>
      smallRow(10_001 + index, Math.floor(index / 3) * 1000 + ((index % 3) + 1) * 250, version),
    ),
  ]);
  // One middle-window part, then monotonically left/right bulk parts for each revision.
  await fixture.seed(small);
  await fixture.command(`/* plan-fixture current normalized input */
    INSERT INTO ${fixture.database}.sensor_scalar_sample
    SELECT id, activity_id, activity_id, user_id, recorded_at, toDate(recorded_at),
      channel, provider_id, external_id, device_id, source_type, 'direct', scalar, 1,
      ingested_at, is_deleted, version, toUInt64(3)
    FROM ${fixture.database}.metric_stream WHERE version=2`);
  await fixture.command(`/* plan-fixture moved former-key tombstone */
    INSERT INTO ${fixture.database}.sensor_scalar_sample VALUES
      (toUUID('${id(41)}'),NULL,NULL,toUUID('${sensorUser}'),toDateTime64('${time(0)}',6),
       toDate('2026-01-15'),'heart_rate','reported',NULL,NULL,NULL,'unknown',0,1,
       toDateTime64('${ingestion[1]}',9),1,2,3)`);

  for (const version of [1, 2] as const) {
    for (let offset = 0; offset < bulkIds; offset += batchRows) {
      const count = Math.min(batchRows, bulkIds - offset);
      const input = `SELECT
        toUUID(concat('10000000-0000-4000-8000-',leftPad(toString(number+2000001),12,'0'))) AS id,
        if(number%2=0,NULL,toUUID('${linkedActivity}')) AS activity_id,
        toUUID('${sensorUser}') AS user_id,
        if(number<${leftIds},
          toDateTime64('2026-01-01',6)+toIntervalSecond(intDiv(number*1209600,${leftIds})),
          toDateTime64('2026-01-16',6)+toIntervalSecond(
            intDiv(greatest(toInt64(number)-${leftIds},0)*1382400,${bulkIds - leftIds}))) AS recorded_at,
        'heart_rate' AS channel,'reported' AS provider_id,
        CAST(NULL,'Nullable(String)') AS external_id,
        CAST(NULL,'Nullable(String)') AS device_id,
        CAST(NULL,'Nullable(String)') AS source_type,
        toFloat32(${version * 111}) AS scalar,'{"measurement_kind":"direct"}' AS metadata,
        toDateTime64('${ingestion[version - 1]}',9) AS ingested_at,
        toInt64(${version}) AS version,toUInt64(1) AS generation,toInt8(0) AS is_deleted
        FROM numbers(${offset},${count})`;
      await fixture.command(`INSERT INTO ${fixture.database}.metric_stream
        (id,activity_id,user_id,recorded_at,channel,provider_id,external_id,device_id,
         source_type,scalar,metadata,ingested_at,version,generation,is_deleted) ${input}`);
      if (version === 2) {
        await fixture.command(`/* plan-fixture current normalized background */
          INSERT INTO ${fixture.database}.sensor_scalar_sample
          SELECT id,activity_id,activity_id,user_id,recorded_at,toDate(recorded_at),
            channel,provider_id,external_id,device_id,source_type,'direct',scalar,1,
            ingested_at,is_deleted,version,toUInt64(3) FROM (${input})`);
      }
    }
  }
}

const partSchema = z.object({
  table: z.string(),
  name: z.string(),
  rows: z.string(),
  marks: z.string(),
});
async function layout(fixture: BoundedSensorFixture, phase: string) {
  const parts = await fixture.read(`SELECT table,name,rows,marks,min_block_number,max_block_number
    FROM system.parts WHERE active AND database='${fixture.database}'
      AND table IN ('metric_stream','source_placement','sensor_scalar_sample') ORDER BY table,name`);
  const projections = await fixture.read(`SELECT table,name,parent_name,rows,marks
    FROM system.projection_parts WHERE active AND database='${fixture.database}' ORDER BY table,name,parent_name`);
  const totals = new Map<string, bigint>();
  for (const row of z.array(partSchema).parse(parts)) {
    const key = `${row.table}/base`;
    totals.set(key, (totals.get(key) ?? 0n) + BigInt(row.marks));
  }
  for (const row of z.array(partSchema).parse(projections)) {
    const key = `${row.table}/${row.name}`;
    totals.set(key, (totals.get(key) ?? 0n) + BigInt(row.marks));
  }
  const evidence = {
    phase,
    expectedMarks,
    parts,
    projections,
    totals: Object.fromEntries([...totals].map(([key, marks]) => [key, marks.toString()])),
  };
  writeFileSync(
    join(dirname(fixture.evidencePath), `${phase}-layout.json`),
    JSON.stringify(evidence, null, 2),
  );
  for (const key of [
    "metric_stream/base",
    "source_placement/base",
    "sensor_scalar_sample/base",
    "metric_stream/by_user_channel_recorded_at",
    "metric_stream/by_provider_generation",
    "metric_stream/by_provider_external_id",
    "source_placement/by_user_channel_recorded_at",
  ]) {
    if (!totals.has(key)) throw new Error(`Access-plan layout unqualified: missing ${key}`);
  }
  for (const [key, marks] of totals) {
    if (marks < 10n * BigInt(expectedMarks.selectedPerRead)) {
      throw new Error(
        `Access-plan layout unqualified: ${key} has ${marks} marks; need at least 160`,
      );
    }
  }
}

let fixture: BoundedSensorFixture;
beforeAll(async () => {
  fixture = new BoundedSensorFixture();
  writeFileSync(
    join(dirname(fixture.evidencePath), "expected-layout.json"),
    JSON.stringify({ sourceIds, bulkIds, rawInputVersions: sourceIds * 2, expectedMarks }, null, 2),
  );
  expect(expectedMarks.minimumRatio).toBeGreaterThanOrEqual(10);
  await fixture.create();
  await loadInput(fixture);
}, 120_000);
afterAll(async () => {
  await fixture.close();
});

it("currentCanonicalPlansHaveDiscriminatingInput", async () => {
  const effects = Array.from({ length: 20 }, (_, index) => ({
    before: smallRow(index + 1, index * 1000, 1),
    after: smallRow(index + 1, index * 1000, 2),
  }));
  await fixture.page(effects, "3", "pulsar");
  const captured = await fixture.capture("scalar");
  expect(captured.vars.analytics_source_ids).toHaveLength(20);
  expect(captured.vars.analytics_keys).toHaveLength(20);
  writeFileSync(
    join(dirname(fixture.evidencePath), "captured-page.json"),
    JSON.stringify(captured, null, 2),
  );
  await layout(fixture, "before-scalar");
  await fixture.explain("scalar");
  await layout(fixture, "before-dedup");
  await fixture.explain("dedup");
  await layout(fixture, "after-dedup");
}, 120_000);

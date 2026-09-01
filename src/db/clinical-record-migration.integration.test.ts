import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "./migrate.ts";
import { clinicalRecord } from "./schema/clinical.ts";
import { setupTestDatabase, type TestContext, writeTestMigrationFiles } from "./test-helpers.ts";

const USER_ID = "10000000-0000-4000-8000-000000000099";
const PROVIDER_ID = "clinical-migration-fixture";

const migratedRecordSchema = z.object({
  clinical_type: z.string(),
  display_name: z.string(),
  downloaded_at: z.coerce.date(),
  external_id: z.string(),
  fhir: z.record(z.string(), z.unknown()),
  fhir_version: z.string(),
  issued_at: z.coerce.date().nullable(),
  recorded_at: z.coerce.date().nullable(),
  source_name: z.string().nullable(),
});

const relationStateSchema = z.object({
  allergy_intolerance: z.boolean(),
  clinical_record: z.boolean(),
  condition: z.boolean(),
  lab_panel: z.boolean(),
  lab_result: z.boolean(),
  medication: z.boolean(),
  medication_dose_event: z.boolean(),
});

const providerStatsSchema = z.object({ clinical_records: z.coerce.number() });

async function restoreLegacyClinicalSchema(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP VIEW fitness.provider_stats");
    await client.query("DROP TABLE IF EXISTS fitness.clinical_record");
    await client.query(`
      DROP TABLE IF EXISTS fitness.lab_result;
      DROP TABLE IF EXISTS fitness.lab_panel;
      DROP TABLE IF EXISTS fitness.medication;
      DROP TABLE IF EXISTS fitness.condition;
      DROP TABLE IF EXISTS fitness.allergy_intolerance;
    `);
    await client.query(`
      CREATE TABLE fitness.lab_panel (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        provider_id text NOT NULL REFERENCES fitness.provider(id),
        user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
        external_id text,
        name text NOT NULL,
        loinc_code text,
        status fitness.lab_result_status,
        source_name text,
        recorded_at timestamptz NOT NULL,
        issued_at timestamptz,
        raw jsonb,
        created_at timestamptz DEFAULT now() NOT NULL
      );
      CREATE TABLE fitness.lab_result (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        provider_id text NOT NULL REFERENCES fitness.provider(id),
        user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
        panel_id uuid REFERENCES fitness.lab_panel(id) ON DELETE CASCADE,
        external_id text,
        test_name text NOT NULL,
        loinc_code text,
        value real,
        value_text text,
        unit text,
        reference_range_low real,
        reference_range_high real,
        reference_range_text text,
        status fitness.lab_result_status,
        source_name text,
        recorded_at timestamptz NOT NULL,
        issued_at timestamptz,
        raw jsonb,
        created_at timestamptz DEFAULT now() NOT NULL
      );
      CREATE TABLE fitness.medication (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        provider_id text NOT NULL REFERENCES fitness.provider(id),
        user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
        external_id text,
        name text NOT NULL,
        status text,
        authored_on date,
        start_date date,
        end_date date,
        dosage_text text,
        route text,
        form text,
        rxnorm_code text,
        prescriber_name text,
        reason_text text,
        reason_snomed_code text,
        source_name text,
        raw jsonb,
        created_at timestamptz DEFAULT now() NOT NULL
      );
      CREATE TABLE fitness.condition (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        provider_id text NOT NULL REFERENCES fitness.provider(id),
        user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
        external_id text,
        name text NOT NULL,
        clinical_status text,
        verification_status text,
        icd10_code text,
        snomed_code text,
        onset_date date,
        abatement_date date,
        recorded_date date,
        source_name text,
        raw jsonb,
        created_at timestamptz DEFAULT now() NOT NULL
      );
      CREATE TABLE fitness.allergy_intolerance (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        provider_id text NOT NULL REFERENCES fitness.provider(id),
        user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
        external_id text,
        name text NOT NULL,
        type text,
        clinical_status text,
        verification_status text,
        rxnorm_code text,
        onset_date date,
        reactions jsonb,
        source_name text,
        raw jsonb,
        created_at timestamptz DEFAULT now() NOT NULL
      );
      CREATE VIEW fitness.provider_stats AS
      SELECT
        NULL::uuid AS user_id,
        NULL::text AS provider_id,
        0::bigint AS lab_panels,
        0::bigint AS lab_results
      WHERE FALSE;
    `);
    await client.query(
      `INSERT INTO fitness.user_profile (id, name)
       VALUES ($1, 'Clinical Migration User')
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    );
    await client.query(
      `INSERT INTO fitness.provider (id, name)
       VALUES ($1, 'Clinical Migration Fixture')
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_ID],
    );
    await client.query(
      `INSERT INTO fitness.lab_panel (
         id, provider_id, user_id, external_id, name, source_name,
         recorded_at, issued_at, raw, created_at
       ) VALUES (
         '30000000-0000-4000-8000-000000000099', $1, $2, 'panel-1',
         'Metabolic panel', 'Clinic A', '2026-01-01T08:00:00Z',
         '2026-01-01T09:00:00Z',
         '{"resourceType":"DiagnosticReport","id":"panel-1","status":"final"}',
         '2026-01-02T08:00:00Z'
       )`,
      [PROVIDER_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO fitness.lab_result (
         id, provider_id, user_id, panel_id, external_id, test_name, value, unit,
         source_name, recorded_at, issued_at, raw, created_at
       ) VALUES (
         '40000000-0000-4000-8000-000000000099', $1, $2,
         '30000000-0000-4000-8000-000000000099', 'observation-1', 'Glucose', 91, 'mg/dL',
         'Clinic A', '2026-01-01T08:30:00Z', '2026-01-01T09:00:00Z', NULL,
         '2026-01-02T08:00:00Z'
       )`,
      [PROVIDER_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO fitness.medication (
         provider_id, user_id, external_id, name, status, authored_on, source_name, raw, created_at
       ) VALUES (
         $1, $2, 'medication-1', 'Atorvastatin', 'active', '2026-01-03', 'Clinic A',
         '{"resourceType":"MedicationRequest","id":"medication-1","status":"active"}',
         '2026-01-04T08:00:00Z'
       )`,
      [PROVIDER_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO fitness.condition (
         provider_id, user_id, external_id, name, clinical_status, recorded_date,
         source_name, raw, created_at
       ) VALUES (
         $1, $2, 'condition-1', 'Hypertension', 'active', '2026-01-05',
         'Clinic B', '{"resourceType":"Condition","id":"condition-1"}',
         '2026-01-06T08:00:00Z'
       )`,
      [PROVIDER_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO fitness.allergy_intolerance (
         id, provider_id, user_id, external_id, name, type, onset_date, source_name, raw, created_at
       ) VALUES (
         '50000000-0000-4000-8000-000000000099', $1, $2, NULL,
         'Penicillin', 'allergy', '2026-01-07', 'Clinic B', NULL,
         '2026-01-08T08:00:00Z'
       )`,
      [PROVIDER_ID, USER_ID],
    );
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

function migrationDirectory(temporaryDirectories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "clinical-record-migration-"));
  temporaryDirectories.push(directory);
  writeTestMigrationFiles(directory, [
    {
      content: readFileSync(
        resolve(import.meta.dirname, "../../drizzle/0099_canonical_clinical_records.sql"),
        "utf8",
      ),
      file: "9001_canonical_clinical_records.sql",
      when: 9_001_000_000_000,
    },
  ]);
  return directory;
}

describe("canonical clinical record migration", () => {
  let context: TestContext;
  let temporaryDirectories: string[];

  beforeEach(async () => {
    temporaryDirectories = [];
    context = await setupTestDatabase();
  }, 120_000);

  afterEach(async () => {
    try {
      await context?.cleanup();
    } finally {
      for (const directory of temporaryDirectories) {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  });

  it("stores one FHIR record per user, provider, and HealthKit UUID", async () => {
    const client = new Client({ connectionString: context.connectionString });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO fitness.user_profile (id, name)
         VALUES ($1, 'Clinical Uniqueness User')
         ON CONFLICT (id) DO NOTHING`,
        [USER_ID],
      );
      await client.query(
        `INSERT INTO fitness.provider (id, name)
         VALUES ($1, 'Clinical Migration Fixture')
         ON CONFLICT (id) DO NOTHING`,
        [PROVIDER_ID],
      );
    } finally {
      await client.end();
    }

    await context.db.insert(clinicalRecord).values({
      clinicalType: "labResult",
      displayName: "Wellness panel",
      downloadedAt: new Date("2026-08-28T12:00:00Z"),
      externalId: "uuid-1",
      fhir: { id: "result-1", resourceType: "Observation" },
      fhirVersion: "R4",
      providerId: PROVIDER_ID,
      userId: USER_ID,
    });

    await expect(
      context.db.insert(clinicalRecord).values({
        clinicalType: "labResult",
        displayName: "Wellness panel duplicate",
        downloadedAt: new Date("2026-08-28T12:00:00Z"),
        externalId: "uuid-1",
        fhir: { id: "result-2", resourceType: "Observation" },
        fhirVersion: "R4",
        providerId: PROVIDER_ID,
        userId: USER_ID,
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
  });

  it("backfills every legacy clinical row then drops only the legacy relations", async () => {
    await restoreLegacyClinicalSchema(context.connectionString);
    await expect(
      runMigrations(context.connectionString, migrationDirectory(temporaryDirectories)),
    ).resolves.toBe(1);

    const client = new Client({ connectionString: context.connectionString });
    await client.connect();
    try {
      const records = z.array(migratedRecordSchema).parse(
        (
          await client.query(
            `SELECT clinical_type, display_name, downloaded_at, external_id, fhir,
                    fhir_version, issued_at, recorded_at, source_name
             FROM fitness.clinical_record
             WHERE user_id = $1 AND provider_id = $2
             ORDER BY clinical_type, display_name`,
            [USER_ID, PROVIDER_ID],
          )
        ).rows,
      );

      expect(records).toHaveLength(5);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            clinical_type: "labResult",
            display_name: "Metabolic panel",
            external_id: "panel-1",
            fhir: { resourceType: "DiagnosticReport", id: "panel-1", status: "final" },
            fhir_version: "R4",
          }),
          expect.objectContaining({
            clinical_type: "labResult",
            display_name: "Glucose",
            external_id: "observation-1",
            fhir: expect.objectContaining({
              id: "observation-1",
              resourceType: "Observation",
              valueQuantity: { unit: "mg/dL", value: 91 },
            }),
          }),
          expect.objectContaining({
            clinical_type: "medication",
            display_name: "Atorvastatin",
            external_id: "medication-1",
          }),
          expect.objectContaining({
            clinical_type: "condition",
            display_name: "Hypertension",
            external_id: "condition-1",
          }),
          expect.objectContaining({
            clinical_type: "allergy",
            display_name: "Penicillin",
            external_id: "50000000-0000-4000-8000-000000000099",
            fhir: expect.objectContaining({
              code: { text: "Penicillin" },
              resourceType: "AllergyIntolerance",
            }),
          }),
        ]),
      );

      const relations = relationStateSchema.parse(
        (
          await client.query(`
            SELECT
              to_regclass('fitness.clinical_record') IS NOT NULL AS clinical_record,
              to_regclass('fitness.lab_panel') IS NOT NULL AS lab_panel,
              to_regclass('fitness.lab_result') IS NOT NULL AS lab_result,
              to_regclass('fitness.medication') IS NOT NULL AS medication,
              to_regclass('fitness.condition') IS NOT NULL AS condition,
              to_regclass('fitness.allergy_intolerance') IS NOT NULL AS allergy_intolerance,
              to_regclass('fitness.medication_dose_event') IS NOT NULL AS medication_dose_event
          `)
        ).rows[0],
      );
      expect(relations).toEqual({
        allergy_intolerance: false,
        clinical_record: true,
        condition: false,
        lab_panel: false,
        lab_result: false,
        medication: false,
        medication_dose_event: true,
      });

      const providerStats = providerStatsSchema.parse(
        (
          await client.query(
            `SELECT clinical_records FROM fitness.provider_stats
             WHERE user_id = $1 AND provider_id = $2`,
            [USER_ID, PROVIDER_ID],
          )
        ).rows[0],
      );
      expect(providerStats).toEqual({ clinical_records: 5 });
    } finally {
      await client.end();
    }
  });
});

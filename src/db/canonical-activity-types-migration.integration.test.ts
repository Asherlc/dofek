import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_ACTIVITY_TYPE_CLASSIFICATIONS,
  LEGACY_ACTIVITY_TYPES,
} from "@dofek/training/activity-types";
import { Client } from "pg";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.ts";
import { writeTestMigrationFiles } from "./test-helpers.ts";

// cspell:ignore conrelid contype functional_fitness relacl relkind relname relnamespace relreplident

const activityIds = {
  football: "00000000-0000-4000-8000-000000000105",
  functionalFitness: "00000000-0000-4000-8000-000000000103",
  openWaterSwimming: "00000000-0000-4000-8000-000000000104",
  other: "00000000-0000-4000-8000-000000000106",
  roadCycling: "00000000-0000-4000-8000-000000000101",
  trailRunning: "00000000-0000-4000-8000-000000000102",
} as const;

interface ActivityTypeRow {
  canonical_type: string;
  modality: string | null;
  provider_type: string;
}

interface CatalogObjectRow {
  definition: string;
  name: string;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_generated: "ALWAYS" | "NEVER";
  is_nullable: "NO" | "YES";
  is_updatable: "NO" | "YES";
  udt_name: string;
}

interface CountRow {
  count: string;
}

interface IdentityRow {
  provider_attnum: number;
  relation_oid: number;
}

interface NameRow {
  name: string;
}

interface ObjectIdentityRow {
  kind: "constraint" | "index";
  name: string;
  object_oid: number;
}

async function createLegacySchema(client: Client): Promise<void> {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA fitness;
    CREATE SCHEMA clickhouse;
    CREATE ROLE activity_reader;

    CREATE TYPE fitness.activity_type AS ENUM (
      ${LEGACY_ACTIVITY_TYPES.map((activityType) => `'${activityType}'`).join(",\n      ")}
    );

    CREATE TABLE fitness.user_profile (
      id uuid PRIMARY KEY
    );

    CREATE TABLE fitness.provider (
      id text PRIMARY KEY
    );

    CREATE TABLE fitness.provider_priority (
      provider_id text PRIMARY KEY,
      priority integer NOT NULL DEFAULT 100
    );

    CREATE TABLE fitness.device_priority (
      provider_id text NOT NULL,
      source_name_pattern text NOT NULL,
      priority integer
    );

    CREATE TABLE fitness.activity (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      provider_id text NOT NULL,
      external_id text NOT NULL,
      activity_type fitness.activity_type NOT NULL,
      started_at timestamptz NOT NULL,
      ended_at timestamptz,
      notes text,
      created_at timestamptz DEFAULT now() NOT NULL,
      raw jsonb,
      name text,
      user_id uuid NOT NULL,
      perceived_exertion real,
      source_name text,
      timezone text,
      strava_id text,
      provider_absent_at timestamptz,
      deleted_at timestamptz,
      CONSTRAINT cardio_activity_pkey PRIMARY KEY (id),
      CONSTRAINT cardio_activity_provider_id_provider_id_fk
        FOREIGN KEY (provider_id) REFERENCES fitness.provider (id),
      CONSTRAINT activity_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES fitness.user_profile (id),
      CONSTRAINT activity_ended_after_started_chk
        CHECK (ended_at IS NULL OR ended_at >= started_at)
    );

    COMMENT ON TABLE fitness.activity IS 'Raw provider activity rows';
    COMMENT ON COLUMN fitness.activity.external_id IS 'Exact provider-side identifier';

    CREATE UNIQUE INDEX activity_provider_external_idx
      ON fitness.activity (user_id, provider_id, external_id);
    CREATE INDEX activity_started_at_idx
      ON fitness.activity (started_at DESC);
    CREATE INDEX activity_user_provider_idx
      ON fitness.activity (user_id, provider_id);
    CREATE INDEX activity_active_user_started_idx
      ON fitness.activity (user_id, started_at DESC)
      WHERE deleted_at IS NULL AND provider_absent_at IS NULL;

    GRANT SELECT ON fitness.activity TO activity_reader;

    CREATE TABLE fitness.activity_interval (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      activity_id uuid NOT NULL,
      CONSTRAINT activity_interval_activity_id_fkey
        FOREIGN KEY (activity_id) REFERENCES fitness.activity (id) ON DELETE CASCADE
    );

    CREATE TABLE fitness.strength_set (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      activity_id uuid NOT NULL,
      CONSTRAINT strength_set_activity_id_activity_id_fk
        FOREIGN KEY (activity_id) REFERENCES fitness.activity (id) ON DELETE CASCADE
    );

    CREATE TABLE fitness.climbing_entry (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      activity_id uuid NOT NULL,
      CONSTRAINT climbing_entry_activity_id_activity_id_fk
        FOREIGN KEY (activity_id) REFERENCES fitness.activity (id) ON DELETE CASCADE
    );

    CREATE VIEW fitness.v_activity AS
    SELECT
      activity.*,
      ARRAY[activity.id] AS member_activity_ids,
      ARRAY[activity.provider_id] AS source_providers,
      ARRAY[]::text[] AS source_links,
      '{}'::jsonb AS source_decision,
      ARRAY[]::text[] AS absent_source_providers,
      ARRAY[]::text[] AS absent_source_external_ids
    FROM fitness.activity;

    CREATE VIEW fitness.v_activity_members AS
    SELECT
      id AS activity_id,
      user_id,
      started_at,
      ended_at,
      UNNEST(member_activity_ids) AS member_activity_id
    FROM fitness.v_activity;

    CREATE VIEW fitness.provider_stats AS
    SELECT
      user_id,
      provider_id,
      count(*)::bigint AS activities
    FROM fitness.activity
    GROUP BY user_id, provider_id;

    CREATE VIEW clickhouse.activity AS
    SELECT
      id,
      user_id,
      provider_id,
      activity_type,
      name,
      started_at,
      ended_at,
      source_name
    FROM fitness.activity;

    CREATE VIEW clickhouse.v_activity AS
    SELECT
      id,
      user_id,
      activity_type,
      name,
      started_at,
      ended_at
    FROM fitness.v_activity;

    CREATE VIEW clickhouse.v_activity_members AS
    SELECT
      activity_id,
      user_id,
      started_at,
      ended_at,
      member_activity_id
    FROM fitness.v_activity_members;

    CREATE PUBLICATION peerdb_raw_analytics_publication
      FOR TABLE fitness.activity;

    INSERT INTO fitness.user_profile (id)
    VALUES ('00000000-0000-4000-8000-000000000001');

    INSERT INTO fitness.provider (id)
    VALUES ('provider-a');

    INSERT INTO fitness.provider_priority (provider_id, priority)
    VALUES ('provider-a', 10);

    INSERT INTO fitness.activity (
      id,
      provider_id,
      external_id,
      activity_type,
      started_at,
      ended_at,
      notes,
      raw,
      name,
      user_id,
      perceived_exertion,
      source_name,
      timezone,
      strava_id
    )
    VALUES
      (
        '${activityIds.roadCycling}',
        'provider-a',
        'road-cycling',
        'road_cycling',
        '2026-07-01T08:00:00Z',
        '2026-07-01T09:00:00Z',
        'Preserve me',
        '{"source":"road"}',
        'Road ride',
        '00000000-0000-4000-8000-000000000001',
        7,
        'Bike Computer',
        'America/Los_Angeles',
        'strava-101'
      ),
      (
        '${activityIds.trailRunning}',
        'provider-a',
        'trail-running',
        'trail_running',
        '2026-07-02T08:00:00Z',
        '2026-07-02T09:00:00Z',
        NULL,
        '{}',
        'Trail run',
        '00000000-0000-4000-8000-000000000001',
        NULL,
        'Watch',
        NULL,
        NULL
      ),
      (
        '${activityIds.functionalFitness}',
        'provider-a',
        'functional-fitness',
        'functional_fitness',
        '2026-07-03T08:00:00Z',
        '2026-07-03T09:00:00Z',
        NULL,
        '{}',
        'Functional fitness',
        '00000000-0000-4000-8000-000000000001',
        NULL,
        NULL,
        NULL,
        NULL
      ),
      (
        '${activityIds.openWaterSwimming}',
        'provider-a',
        'open-water-swimming',
        'open_water_swimming',
        '2026-07-04T08:00:00Z',
        '2026-07-04T09:00:00Z',
        NULL,
        '{}',
        'Open water swim',
        '00000000-0000-4000-8000-000000000001',
        NULL,
        NULL,
        NULL,
        NULL
      ),
      (
        '${activityIds.football}',
        'provider-a',
        'football',
        'football',
        '2026-07-05T08:00:00Z',
        '2026-07-05T09:00:00Z',
        NULL,
        '{}',
        'Football',
        '00000000-0000-4000-8000-000000000001',
        NULL,
        NULL,
        NULL,
        NULL
      ),
      (
        '${activityIds.other}',
        'provider-a',
        'other',
        'other',
        '2026-07-06T08:00:00Z',
        '2026-07-06T09:00:00Z',
        NULL,
        '{}',
        'Other',
        '00000000-0000-4000-8000-000000000001',
        NULL,
        NULL,
        NULL,
        NULL
      );

    INSERT INTO fitness.activity (
      provider_id,
      external_id,
      activity_type,
      started_at,
      ended_at,
      raw,
      name,
      user_id
    )
    SELECT
      'provider-a',
      'bulk-' || legacy_type::text,
      legacy_type,
      '2026-06-01T08:00:00Z',
      '2026-06-01T09:00:00Z',
      '{}'::jsonb,
      legacy_type::text,
      '00000000-0000-4000-8000-000000000001'
    FROM unnest(enum_range(NULL::fitness.activity_type)) AS legacy_type
    WHERE legacy_type::text NOT IN (
      'road_cycling',
      'trail_running',
      'functional_fitness',
      'open_water_swimming',
      'football',
      'other'
    );

    INSERT INTO fitness.activity_interval (activity_id)
    VALUES ('${activityIds.roadCycling}');

    INSERT INTO fitness.strength_set (activity_id)
    VALUES ('${activityIds.roadCycling}');

    INSERT INTO fitness.climbing_entry (activity_id)
    VALUES ('${activityIds.roadCycling}');
  `);
}

describe("canonical activity types Postgres migration", () => {
  let connectionString: string;
  let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(
      "mirror.gcr.io/timescale/timescaledb-ha:pg18.3-ts2.26.4-all",
    )
      .withEnvironment({
        POSTGRES_DB: "test",
        POSTGRES_PASSWORD: "test",
        POSTGRES_USER: "test",
      })
      .withExposedPorts(5432)
      .start();

    connectionString = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("normalizes in place and preserves the complete activity table contract", async () => {
    const client = new Client({ connectionString });
    let migrationDirectory: string | undefined;
    await client.connect();

    try {
      await createLegacySchema(client);

      const identityBefore = await client.query<IdentityRow>(`
        SELECT
          'fitness.activity'::regclass::oid::integer AS relation_oid,
          attribute.attnum::integer AS provider_attnum
        FROM pg_attribute AS attribute
        WHERE attribute.attrelid = 'fitness.activity'::regclass
          AND attribute.attname = 'activity_type'
      `);
      expect(identityBefore.rows).toHaveLength(1);

      const catalogObjectsBefore = await client.query<ObjectIdentityRow>(`
        SELECT
          'constraint'::text AS kind,
          constraint_record.conname AS name,
          constraint_record.oid::integer AS object_oid
        FROM pg_constraint AS constraint_record
        WHERE constraint_record.conrelid = 'fitness.activity'::regclass
          OR constraint_record.confrelid = 'fitness.activity'::regclass
        UNION ALL
        SELECT
          'index'::text AS kind,
          index_class.relname AS name,
          index_class.oid::integer AS object_oid
        FROM pg_index AS index_record
        INNER JOIN pg_class AS index_class ON index_class.oid = index_record.indexrelid
        WHERE index_record.indrelid = 'fitness.activity'::regclass
        ORDER BY kind, name
      `);

      migrationDirectory = mkdtempSync(join(tmpdir(), "canonical-activity-types-"));
      const migrationContent = readFileSync(
        join(import.meta.dirname, "../../drizzle/0065_canonical_activity_types.sql"),
        "utf8",
      );
      writeTestMigrationFiles(migrationDirectory, [
        {
          content: migrationContent,
          file: "0065_canonical_activity_types.sql",
          when: 2_100_000_000_000,
        },
      ]);

      expect(await runMigrations(connectionString, migrationDirectory)).toBe(1);

      const identityAfter = await client.query<IdentityRow>(`
        SELECT
          'fitness.activity'::regclass::oid::integer AS relation_oid,
          attribute.attnum::integer AS provider_attnum
        FROM pg_attribute AS attribute
        WHERE attribute.attrelid = 'fitness.activity'::regclass
          AND attribute.attname = 'provider_type'
      `);
      expect(identityAfter.rows).toEqual(identityBefore.rows);

      const catalogObjectsAfter = await client.query<ObjectIdentityRow>(`
        SELECT
          'constraint'::text AS kind,
          constraint_record.conname AS name,
          constraint_record.oid::integer AS object_oid
        FROM pg_constraint AS constraint_record
        WHERE constraint_record.conrelid = 'fitness.activity'::regclass
          OR constraint_record.confrelid = 'fitness.activity'::regclass
        UNION ALL
        SELECT
          'index'::text AS kind,
          index_class.relname AS name,
          index_class.oid::integer AS object_oid
        FROM pg_index AS index_record
        INNER JOIN pg_class AS index_class ON index_class.oid = index_record.indexrelid
        WHERE index_record.indrelid = 'fitness.activity'::regclass
        ORDER BY kind, name
      `);
      expect(catalogObjectsAfter.rows).toEqual(catalogObjectsBefore.rows);

      const normalizedRows = await client.query<ActivityTypeRow>(`
        SELECT canonical_type::text, provider_type, modality::text
        FROM fitness.activity
        WHERE external_id NOT LIKE 'bulk-%'
        ORDER BY external_id
      `);
      expect(normalizedRows.rows).toEqual([
        {
          canonical_type: "american_football",
          modality: null,
          provider_type: "football",
        },
        {
          canonical_type: "strength",
          modality: "functional",
          provider_type: "functional_fitness",
        },
        {
          canonical_type: "swimming",
          modality: "open_water",
          provider_type: "open_water_swimming",
        },
        {
          canonical_type: "other",
          modality: null,
          provider_type: "other",
        },
        {
          canonical_type: "cycling",
          modality: "road",
          provider_type: "road_cycling",
        },
        {
          canonical_type: "running",
          modality: "trail",
          provider_type: "trail_running",
        },
      ]);

      const everyLegacyType = await client.query<ActivityTypeRow>(`
        SELECT canonical_type::text, provider_type, modality::text
        FROM fitness.activity
        ORDER BY provider_type
      `);
      expect(everyLegacyType.rows).toEqual(
        [...LEGACY_ACTIVITY_TYPES].sort().map((providerType) => ({
          canonical_type: LEGACY_ACTIVITY_TYPE_CLASSIFICATIONS[providerType].canonicalType,
          modality: LEGACY_ACTIVITY_TYPE_CLASSIFICATIONS[providerType].modality,
          provider_type: providerType,
        })),
      );

      const preservedRow = await client.query<{
        notes: string;
        perceived_exertion: number;
        raw: { source: string };
        strava_id: string;
        timezone: string;
      }>(
        `SELECT notes, perceived_exertion, raw, strava_id, timezone
         FROM fitness.activity
         WHERE id = $1`,
        [activityIds.roadCycling],
      );
      expect(preservedRow.rows).toEqual([
        {
          notes: "Preserve me",
          perceived_exertion: 7,
          raw: { source: "road" },
          strava_id: "strava-101",
          timezone: "America/Los_Angeles",
        },
      ]);

      const typeColumns = await client.query<ColumnRow>(`
        SELECT
          column_name,
          data_type,
          is_generated,
          is_nullable,
          is_updatable,
          udt_name
        FROM information_schema.columns
        WHERE table_schema = 'fitness'
          AND table_name = 'activity'
          AND column_name IN ('activity_type', 'canonical_type', 'provider_type', 'modality')
        ORDER BY column_name
      `);
      expect(typeColumns.rows).toEqual([
        {
          column_name: "canonical_type",
          data_type: "USER-DEFINED",
          is_generated: "NEVER",
          is_nullable: "NO",
          is_updatable: "YES",
          udt_name: "canonical_activity_type",
        },
        {
          column_name: "modality",
          data_type: "USER-DEFINED",
          is_generated: "NEVER",
          is_nullable: "YES",
          is_updatable: "YES",
          udt_name: "activity_modality",
        },
        {
          column_name: "provider_type",
          data_type: "text",
          is_generated: "NEVER",
          is_nullable: "NO",
          is_updatable: "YES",
          udt_name: "text",
        },
      ]);

      await client.query(`
        INSERT INTO fitness.activity (
          provider_id,
          external_id,
          canonical_type,
          provider_type,
          modality,
          started_at,
          user_id
        )
        VALUES (
          'provider-a',
          'writable-canonical-columns',
          'running',
          'road_running',
          'road',
          now(),
          '00000000-0000-4000-8000-000000000001'
        )
      `);
      const writableColumns = await client.query<ActivityTypeRow>(`
        UPDATE fitness.activity
        SET
          canonical_type = 'walking',
          provider_type = 'provider_walk',
          modality = NULL
        WHERE external_id = 'writable-canonical-columns'
        RETURNING canonical_type::text, provider_type, modality::text
      `);
      expect(writableColumns.rows).toEqual([
        {
          canonical_type: "walking",
          modality: null,
          provider_type: "provider_walk",
        },
      ]);

      const constraints = await client.query<CatalogObjectRow>(`
        SELECT
          constraint_name AS name,
          pg_get_constraintdef(pg_constraint.oid, true) AS definition
        FROM information_schema.table_constraints
        JOIN pg_constraint ON pg_constraint.conname = constraint_name
          AND pg_constraint.conrelid = 'fitness.activity'::regclass
        WHERE table_schema = 'fitness'
          AND table_name = 'activity'
        ORDER BY constraint_name
      `);
      expect(constraints.rows.map((row) => row.name)).toEqual([
        "activity_ended_after_started_chk",
        "activity_user_id_fkey",
        "cardio_activity_pkey",
        "cardio_activity_provider_id_provider_id_fk",
      ]);

      const indexes = await client.query<CatalogObjectRow>(`
        SELECT indexname AS name, indexdef AS definition
        FROM pg_indexes
        WHERE schemaname = 'fitness'
          AND tablename = 'activity'
        ORDER BY indexname
      `);
      expect(indexes.rows.map((row) => row.name)).toEqual([
        "activity_active_user_started_idx",
        "activity_provider_external_idx",
        "activity_started_at_idx",
        "activity_user_provider_idx",
        "cardio_activity_pkey",
      ]);
      expect(
        indexes.rows.find((row) => row.name === "activity_active_user_started_idx")?.definition,
      ).toContain("WHERE ((deleted_at IS NULL) AND (provider_absent_at IS NULL))");

      const defaults = await client.query<CatalogObjectRow>(`
        SELECT column_name AS name, column_default AS definition
        FROM information_schema.columns
        WHERE table_schema = 'fitness'
          AND table_name = 'activity'
          AND column_name IN ('id', 'created_at')
        ORDER BY column_name
      `);
      expect(defaults.rows).toEqual([
        { definition: "now()", name: "created_at" },
        { definition: "gen_random_uuid()", name: "id" },
      ]);

      const inboundForeignKeys = await client.query<NameRow>(`
        SELECT conname AS name
        FROM pg_constraint
        WHERE contype = 'f'
          AND confrelid = 'fitness.activity'::regclass
        ORDER BY conname
      `);
      expect(inboundForeignKeys.rows).toEqual([
        { name: "activity_interval_activity_id_fkey" },
        { name: "climbing_entry_activity_id_activity_id_fk" },
        { name: "strength_set_activity_id_activity_id_fk" },
      ]);

      await expect(
        client.query(`
          INSERT INTO fitness.activity (
            provider_id,
            external_id,
            canonical_type,
            provider_type,
            started_at,
            user_id
          )
          VALUES (
            'missing-provider',
            'invalid-provider',
            'running',
            'running',
            now(),
            '00000000-0000-4000-8000-000000000001'
          )
        `),
      ).rejects.toThrow();

      await client.query("DELETE FROM fitness.activity WHERE id = $1", [activityIds.roadCycling]);
      for (const tableName of ["activity_interval", "strength_set", "climbing_entry"]) {
        const childRows = await client.query<CountRow>(`SELECT count(*) FROM fitness.${tableName}`);
        expect(childRows.rows).toEqual([{ count: "0" }]);
      }

      const dependentViews = await client.query<NameRow>(`
        SELECT schemaname || '.' || viewname AS name
        FROM pg_views
        WHERE (schemaname, viewname) IN (
          ('fitness', 'v_activity'),
          ('fitness', 'v_activity_members'),
          ('fitness', 'provider_stats'),
          ('clickhouse', 'activity'),
          ('clickhouse', 'v_activity'),
          ('clickhouse', 'v_activity_members')
        )
        ORDER BY name
      `);
      expect(dependentViews.rows).toEqual([
        { name: "clickhouse.activity" },
        { name: "clickhouse.v_activity" },
        { name: "clickhouse.v_activity_members" },
        { name: "fitness.provider_stats" },
        { name: "fitness.v_activity" },
        { name: "fitness.v_activity_members" },
      ]);

      const canonicalViewColumns = await client.query<NameRow>(`
        SELECT column_name AS name
        FROM information_schema.columns
        WHERE table_schema = 'clickhouse'
          AND table_name = 'activity'
        ORDER BY ordinal_position
      `);
      expect(canonicalViewColumns.rows.map((row) => row.name)).toEqual([
        "id",
        "user_id",
        "provider_id",
        "canonical_type",
        "provider_type",
        "modality",
        "name",
        "started_at",
        "ended_at",
        "source_name",
      ]);

      const publicationRows = await client.query<NameRow>(`
        SELECT pubname AS name
        FROM pg_publication_tables
        WHERE schemaname = 'fitness'
          AND tablename = 'activity'
        ORDER BY pubname
      `);
      expect(publicationRows.rows).toEqual([{ name: "peerdb_raw_analytics_publication" }]);

      const ownershipAndReplicaIdentity = await client.query<{
        owner_name: string;
        replica_identity: string;
      }>(`
        SELECT
          pg_get_userbyid(class.relowner) AS owner_name,
          class.relreplident AS replica_identity
        FROM pg_class AS class
        WHERE class.oid = 'fitness.activity'::regclass
      `);
      expect(ownershipAndReplicaIdentity.rows).toEqual([
        { owner_name: "test", replica_identity: "d" },
      ]);

      const grants = await client.query<{
        grantee: string;
        privilege_type: string;
      }>(`
        SELECT grantee, privilege_type
        FROM information_schema.role_table_grants
        WHERE table_schema = 'fitness'
          AND table_name = 'activity'
          AND grantee = 'activity_reader'
        ORDER BY privilege_type
      `);
      expect(grants.rows).toEqual([{ grantee: "activity_reader", privilege_type: "SELECT" }]);

      const comments = await client.query<{
        column_comment: string;
        table_comment: string;
      }>(`
        SELECT
          obj_description('fitness.activity'::regclass, 'pg_class') AS table_comment,
          col_description('fitness.activity'::regclass, attribute.attnum) AS column_comment
        FROM pg_attribute AS attribute
        WHERE attribute.attrelid = 'fitness.activity'::regclass
          AND attribute.attname = 'external_id'
      `);
      expect(comments.rows).toEqual([
        {
          column_comment: "Exact provider-side identifier",
          table_comment: "Raw provider activity rows",
        },
      ]);

      const unsupportedCatalogFeatures = await client.query<{
        hypertables: string;
        policies: string;
        sequences: string;
        triggers: string;
      }>(`
        SELECT
          (
            SELECT count(*)::text
            FROM timescaledb_information.hypertables
            WHERE hypertable_schema = 'fitness'
              AND hypertable_name = 'activity'
          ) AS hypertables,
          (
            SELECT count(*)::text
            FROM pg_policy
            WHERE polrelid = 'fitness.activity'::regclass
          ) AS policies,
          (
            SELECT count(*)::text
            FROM pg_trigger
            WHERE tgrelid = 'fitness.activity'::regclass
              AND NOT tgisinternal
          ) AS triggers,
          (
            SELECT count(*)::text
            FROM pg_depend
            WHERE refobjid = 'fitness.activity'::regclass
              AND classid = 'pg_class'::regclass
              AND deptype = 'a'
          ) AS sequences
      `);
      expect(unsupportedCatalogFeatures.rows).toEqual([
        { hypertables: "0", policies: "0", sequences: "0", triggers: "0" },
      ]);
    } finally {
      await client.end();
      if (migrationDirectory) {
        rmSync(migrationDirectory, { force: true, recursive: true });
      }
    }
  }, 120_000);
});

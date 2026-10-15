import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { drizzleSchema } from "./drizzle-schema.ts";
import { userSettings } from "./schema/account.ts";
import { activity, fingerLoadingEntry, strengthSet } from "./schema/activity.ts";
import {
  area,
  climb,
  climbGrade,
  climbingAttempt,
  climbingLogEntry,
  climbingLogEntryGrade,
  pitch,
  pitchGrade,
} from "./schema/climbing.ts";
import { clinicalRecord } from "./schema/clinical.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import {
  activityModalityEnum,
  attemptOutcomeEnum,
  attemptScopeEnum,
  canonicalActivityTypeEnum,
  climbingDisciplineEnum,
  climbingHoldTypeEnum,
  climbKindEnum,
  climbSettingEnum,
  fingerLoadingExerciseEnum,
  fingerLoadingGripPositionEnum,
  fingerLoadingLateralityEnum,
  gradeSystemEnum,
  protectionStyleEnum,
  ropeMethodEnum,
} from "./schema/enums.ts";
import { foodEntry } from "./schema/nutrition.ts";
import { provider } from "./schema/reference.ts";

type DrizzleTable = Parameters<typeof getTableConfig>[0];

interface ColumnSummary {
  columnType: string;
  dataType: string;
  hasDefault: boolean;
  name: string;
  notNull: boolean;
  primary: boolean;
}

function columnSummaries(table: DrizzleTable): Record<string, ColumnSummary> {
  const config = getTableConfig(table);
  const entries = config.columns.map((column) => [
    column.name,
    {
      columnType: column.columnType,
      dataType: column.dataType,
      hasDefault: column.hasDefault,
      name: column.name,
      notNull: column.notNull,
      primary: column.primary,
    },
  ]);

  return Object.fromEntries(entries);
}

describe("drizzleSchema", () => {
  it("aggregates all database schema modules", () => {
    expect(drizzleSchema).toMatchObject({
      TEST_USER_ID,
      activityModalityEnum,
      canonicalActivityTypeEnum,
      provider,
      activity,
      foodEntry,
      clinicalRecord,
      userSettings,
    });
  });

  it("aggregates climbing log entities and enums", () => {
    expect(drizzleSchema).toMatchObject({
      climbingAttempt,
      attemptOutcomeEnum,
      area,
      climb,
      pitch,
      climbGrade,
      pitchGrade,
      climbingLogEntryGrade,
      climbingLogEntry,
      climbKindEnum,
      climbSettingEnum,
      climbingDisciplineEnum,
      ropeMethodEnum,
      protectionStyleEnum,
      attemptScopeEnum,
      gradeSystemEnum,
      climbingHoldTypeEnum,
      fingerLoadingEntry,
      fingerLoadingExerciseEnum,
      fingerLoadingGripPositionEnum,
      fingerLoadingLateralityEnum,
    });
  });

  it("defines canonical finger-loading protocol entries", () => {
    const config = getTableConfig(fingerLoadingEntry);
    const columns = columnSummaries(fingerLoadingEntry);

    expect(config.schema).toBe("fitness");
    expect(config.name).toBe("finger_loading_entry");
    expect(Object.keys(columns)).toEqual([
      "id",
      "activity_id",
      "exercise",
      "edge_size_mm",
      "grip_position",
      "external_load_kg",
      "bodyweight_kg",
      "laterality",
      "set_count",
      "hold_duration_seconds",
      "rest_interval_seconds",
      "rpe",
      "notes",
      "created_at",
    ]);
    expect(columns).toMatchObject({
      activity_id: { columnType: "PgUUID", notNull: true },
      exercise: { columnType: "PgEnumColumn", notNull: true },
      external_load_kg: { columnType: "PgReal", notNull: true },
      bodyweight_kg: { columnType: "PgReal", notNull: true },
      set_count: { columnType: "PgInteger", notNull: true },
      hold_duration_seconds: { columnType: "PgReal", notNull: true },
      rest_interval_seconds: { columnType: "PgInteger", notNull: true },
    });
    expect(config.indexes.map((indexBuilder) => indexBuilder.config.name)).toContain(
      "finger_loading_entry_activity_idx",
    );
    expect(config.checks.map((checkBuilder) => checkBuilder.name)).toContain(
      "finger_loading_entry_effective_load_positive",
    );
  });

  it("retains the original provider record on every normalized strength set", () => {
    const columns = columnSummaries(strengthSet);

    expect(columns.raw).toMatchObject({
      columnType: "PgJsonb",
      hasDefault: true,
      notNull: true,
    });
  });
});

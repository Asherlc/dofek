import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { drizzleSchema } from "./drizzle-schema.ts";
import { userSettings } from "./schema/account.ts";
import { activity, climbingAttempt, climbingEntry, fingerLoadingEntry } from "./schema/activity.ts";
import { labResult } from "./schema/clinical.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import {
  activityModalityEnum,
  canonicalActivityTypeEnum,
  climbingAttemptOutcomeEnum,
  climbingClimbTypeEnum,
  climbingFailureReasonEnum,
  climbingGradeSystemEnum,
  climbingHoldTypeEnum,
  fingerLoadingExerciseEnum,
  fingerLoadingGripPositionEnum,
  fingerLoadingLateralityEnum,
} from "./schema/enums.ts";
import { journalEntry } from "./schema/events.ts";
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

function indexedColumnNames(columns: readonly unknown[]): string[] {
  return columns.map((column, index) => {
    if (
      typeof column === "object" &&
      column !== null &&
      "name" in column &&
      typeof column.name === "string"
    ) {
      return column.name;
    }

    throw new Error(
      `Expected index metadata at position ${index} to reference named table columns`,
    );
  });
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
      labResult,
      userSettings,
      journalEntry,
    });
  });

  it("aggregates climbing entry schema and climbing enums", () => {
    expect(drizzleSchema).toMatchObject({
      climbingAttempt,
      climbingAttemptOutcomeEnum,
      climbingEntry,
      climbingClimbTypeEnum,
      climbingFailureReasonEnum,
      climbingGradeSystemEnum,
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

  it("defines ordered climbing-attempt detail without requiring imported aggregates", () => {
    const climbingConfig = getTableConfig(climbingEntry);
    const climbingColumns = columnSummaries(climbingEntry);
    const attemptConfig = getTableConfig(climbingAttempt);
    const attemptColumns = columnSummaries(climbingAttempt);

    expect(climbingColumns).toMatchObject({
      sent: { notNull: false },
      attempt_count: { notNull: false },
      wall_angle_degrees: { columnType: "PgReal", notNull: false },
      hold_type: { columnType: "PgEnumColumn", notNull: false },
    });
    expect(attemptConfig.schema).toBe("fitness");
    expect(attemptConfig.name).toBe("climbing_attempt");
    expect(Object.keys(attemptColumns)).toEqual([
      "id",
      "climbing_entry_id",
      "attempt_index",
      "outcome",
      "failure_reason",
      "notes",
      "created_at",
    ]);
    expect(
      attemptConfig.indexes.map((indexBuilder) => ({
        name: indexBuilder.config.name,
        unique: indexBuilder.config.unique,
      })),
    ).toEqual(
      expect.arrayContaining([
        { name: "climbing_attempt_entry_idx", unique: false },
        { name: "climbing_attempt_entry_index_idx", unique: true },
      ]),
    );
    expect(climbingConfig.checks.map((checkBuilder) => checkBuilder.name)).toContain(
      "climbing_entry_aggregate_pair",
    );
  });

  it("defines fitness.climbing_entry as an activity-linked climbing log table", () => {
    const config = getTableConfig(climbingEntry);
    const columns = columnSummaries(climbingEntry);

    expect(config.schema).toBe("fitness");
    expect(config.name).toBe("climbing_entry");
    expect(Object.keys(columns)).toEqual([
      "id",
      "activity_id",
      "external_id",
      "climb_type",
      "grade_system",
      "grade",
      "sent",
      "attempt_count",
      "lead",
      "wall_angle_degrees",
      "hold_type",
      "route_name",
      "location_name",
      "source_name",
      "raw",
      "created_at",
    ]);
    expect(columns).toMatchObject({
      id: {
        columnType: "PgUUID",
        hasDefault: true,
        notNull: true,
        primary: true,
      },
      activity_id: {
        columnType: "PgUUID",
        hasDefault: false,
        notNull: true,
      },
      external_id: {
        columnType: "PgText",
        hasDefault: false,
        notNull: false,
      },
      climb_type: {
        columnType: "PgEnumColumn",
        dataType: "string",
        hasDefault: false,
        notNull: true,
      },
      grade_system: {
        columnType: "PgEnumColumn",
        dataType: "string",
        hasDefault: false,
        notNull: true,
      },
      grade: {
        columnType: "PgText",
        hasDefault: false,
        notNull: true,
      },
      sent: {
        columnType: "PgBoolean",
        hasDefault: false,
        notNull: false,
      },
      attempt_count: {
        columnType: "PgInteger",
        hasDefault: true,
        notNull: false,
      },
      lead: {
        columnType: "PgBoolean",
        hasDefault: false,
        notNull: false,
      },
      wall_angle_degrees: {
        columnType: "PgReal",
        hasDefault: false,
        notNull: false,
      },
      hold_type: {
        columnType: "PgEnumColumn",
        hasDefault: false,
        notNull: false,
      },
      route_name: {
        columnType: "PgText",
        hasDefault: false,
        notNull: false,
      },
      location_name: {
        columnType: "PgText",
        hasDefault: false,
        notNull: false,
      },
      source_name: {
        columnType: "PgText",
        hasDefault: false,
        notNull: false,
      },
      raw: {
        columnType: "PgJsonb",
        hasDefault: false,
        notNull: false,
      },
      created_at: {
        columnType: "PgTimestamp",
        hasDefault: true,
        notNull: true,
      },
    });
  });

  it("constrains climbing entry relationships and query indexes", () => {
    const config = getTableConfig(climbingEntry);
    const foreignKeys = config.foreignKeys.map((foreignKeyBuilder) => {
      const reference = foreignKeyBuilder.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        foreignColumns: reference.foreignColumns.map((column) => column.name),
        foreignTableName: getTableConfig(reference.foreignTable).name,
        onDelete: foreignKeyBuilder.onDelete,
      };
    });
    const indexes = config.indexes.map((indexBuilder) => ({
      columns: indexedColumnNames(indexBuilder.config.columns),
      name: indexBuilder.config.name,
      unique: indexBuilder.config.unique,
    }));

    expect(foreignKeys).toContainEqual({
      columns: ["activity_id"],
      foreignColumns: ["id"],
      foreignTableName: "activity",
      onDelete: "cascade",
    });
    expect(indexes).toEqual(
      expect.arrayContaining([
        {
          columns: ["activity_id"],
          name: "climbing_entry_activity_idx",
          unique: false,
        },
        {
          columns: ["climb_type", "grade_system", "grade"],
          name: "climbing_entry_grade_lookup_idx",
          unique: false,
        },
        {
          columns: ["activity_id", "external_id"],
          name: "climbing_entry_activity_external_id_idx",
          unique: true,
        },
      ]),
    );
  });

  it("defines constrained climbing enums", () => {
    expect(climbingClimbTypeEnum.enumName).toBe("climbing_climb_type");
    expect(climbingClimbTypeEnum.enumValues).toEqual(["boulder", "route"]);
    expect(climbingGradeSystemEnum.enumName).toBe("climbing_grade_system");
    expect(climbingGradeSystemEnum.enumValues).toEqual([
      "v_scale",
      "font",
      "yds",
      "french",
      "uiaa",
      "ewbank",
      "saxon",
      "norwegian",
      "brazilian_crux",
    ]);
  });
});

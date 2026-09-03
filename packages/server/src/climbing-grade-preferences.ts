import {
  type ClimbingGradePreference,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
} from "@dofek/training/climbing-grades";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "./lib/typed-sql.ts";

export const CLIMBING_GRADE_PREFERENCE_SETTINGS_KEY = "climbingGradeSystems";

export const climbingGradePreferenceSchema = z.strictObject({
  boulder: z.enum(["v_scale", "font"]),
  route: z.enum(["yds", "french", "uiaa", "ewbank", "saxon", "norwegian", "brazilian_crux"]),
});

export function resolveClimbingGradePreference(value: unknown): ClimbingGradePreference {
  const parsed = climbingGradePreferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_CLIMBING_GRADE_PREFERENCE;
}

const climbingGradePreferenceRowSchema = z.object({ value: z.unknown() });

export async function loadClimbingGradePreference(
  database: Pick<Database, "execute">,
  userId: string,
): Promise<ClimbingGradePreference> {
  const rows = await executeWithSchema(
    database,
    climbingGradePreferenceRowSchema,
    sql`SELECT value FROM fitness.user_settings
        WHERE user_id = ${userId}::uuid
          AND key = ${CLIMBING_GRADE_PREFERENCE_SETTINGS_KEY}
        LIMIT 1`,
  );
  return resolveClimbingGradePreference(rows[0]?.value);
}

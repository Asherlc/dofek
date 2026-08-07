import type { NutritionCalorieTargetType } from "@dofek/nutrition/selected-date-summary";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schemas for DB rows
// ---------------------------------------------------------------------------

const settingRowSchema = z.object({ key: z.string(), value: z.unknown() });
const providerAccountRowSchema = z.object({ provider_account_id: z.string() });

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Setting {
  key: string;
  value: unknown;
}

export interface SlackStatus {
  configured: boolean;
  connected: boolean;
}

export interface CalorieGoalContext {
  target: number;
  type: NutritionCalorieTargetType;
}

// ---------------------------------------------------------------------------
// Tables deleted during full user data wipe
// ---------------------------------------------------------------------------

const USER_SCOPED_DELETE_TABLES = [
  "fitness.user_settings",
  "fitness.life_events",
  "fitness.menstrual_period",
  "fitness.sport_settings",
  "fitness.supplement_dose_event",
  "fitness.supplement",
];

const GLOBAL_PROVIDER_TABLES = new Set(["fitness.exercise_alias"]);
export const DEFAULT_CALORIE_GOAL = 2000;

function parseCalorieGoal(value: unknown): CalorieGoalContext {
  const numericValue =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  const roundedValue = Math.round(numericValue);
  if (Number.isFinite(roundedValue) && roundedValue > 0) {
    return { target: roundedValue, type: "configured" };
  }
  return { target: DEFAULT_CALORIE_GOAL, type: "default" };
}

function isUndefinedTableError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("does not exist");
  }
  if (typeof error === "object" && error !== null) {
    if ("code" in error && error.code === "42P01") {
      return true;
    }
    if ("message" in error && typeof error.message === "string") {
      return error.message.includes("does not exist");
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for user settings and account management. */
export class SettingsRepository {
  readonly #db: Pick<Database, "execute" | "transaction">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute" | "transaction">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Get a single setting by key. Returns null if not found. */
  async get(key: string): Promise<Setting | null> {
    const rows = await executeWithSchema(
      this.#db,
      settingRowSchema,
      sql`SELECT key, value FROM fitness.user_settings WHERE user_id = ${this.#userId} AND key = ${key} LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return { key: row.key, value: row.value };
  }

  /** Get all settings for the user, ordered by key. */
  async getAll(): Promise<Setting[]> {
    const rows = await executeWithSchema(
      this.#db,
      settingRowSchema,
      sql`SELECT key, value FROM fitness.user_settings WHERE user_id = ${this.#userId} ORDER BY key`,
    );
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }

  /** Get the user's positive calorie goal, or the canonical default. */
  async getCalorieGoal(): Promise<number> {
    return (await this.getCalorieGoalContext()).target;
  }

  /** Get the user's calorie target and whether it uses the configured or default value. */
  async getCalorieGoalContext(): Promise<CalorieGoalContext> {
    const setting = await this.get("calorieGoal");
    return parseCalorieGoal(setting?.value);
  }

  /** Upsert a setting. Returns the saved setting or throws on failure. */
  async set(key: string, value: unknown): Promise<Setting> {
    const rows = await executeWithSchema(
      this.#db,
      settingRowSchema,
      sql`INSERT INTO fitness.user_settings (user_id, key, value, updated_at)
          VALUES (${this.#userId}, ${key}, ${JSON.stringify(value)}::jsonb, NOW())
          ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
          RETURNING key, value`,
    );
    const result = rows[0];
    if (!result) throw new Error("Failed to upsert setting");
    return { key: result.key, value: result.value };
  }

  /** Check Slack integration status (env vars + OAuth connection). */
  async slackStatus(): Promise<SlackStatus> {
    const rows = await executeWithSchema(
      this.#db,
      providerAccountRowSchema,
      sql`SELECT provider_account_id FROM fitness.auth_account
          WHERE user_id = ${this.#userId} AND auth_provider = 'slack'
          LIMIT 1`,
    );
    const oauthMode = !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_SIGNING_SECRET);
    const socketMode = !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
    const configured = oauthMode || socketMode;
    return {
      configured,
      connected: rows.length > 0,
    };
  }

  /**
   * Delete all user data across provider-scoped and user-scoped tables.
   * Runs inside a transaction.
   */
  async deleteAllUserData(providerChildTables: string[]): Promise<void> {
    await this.#db.transaction(async (transaction) => {
      const deleteTable = async (table: string): Promise<void> => {
        await transaction.execute(sql`SAVEPOINT dofek_delete_user_data`);
        try {
          await transaction.execute(
            sql`DELETE FROM ${sql.raw(table)} WHERE user_id = ${this.#userId}`,
          );
        } catch (error: unknown) {
          await transaction.execute(sql`ROLLBACK TO SAVEPOINT dofek_delete_user_data`);
          await transaction.execute(sql`RELEASE SAVEPOINT dofek_delete_user_data`);
          if (!isUndefinedTableError(error)) {
            throw error;
          }
          return;
        }
        await transaction.execute(sql`RELEASE SAVEPOINT dofek_delete_user_data`);
      };

      for (const table of providerChildTables) {
        if (GLOBAL_PROVIDER_TABLES.has(table)) {
          continue;
        }
        await deleteTable(table);
      }

      for (const table of USER_SCOPED_DELETE_TABLES) {
        await deleteTable(table);
      }
    });
  }
}

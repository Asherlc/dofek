import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowEnd, dateWindowStart, timestampWindowStart } from "../lib/date-window.ts";
import { sleepNightDate } from "../lib/sql-fragments.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface AnomalyRow {
  date: string;
  metric: string;
  value: number;
  baselineMean: number;
  baselineStddev: number;
  zScore: number;
  severity: "warning" | "alert";
}

export interface AnomalyCheckResult {
  anomalies: AnomalyRow[];
  checkedMetrics: string[];
}

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const anomalyCheckRowSchema = z.object({
  date: dateStringSchema.nullable(),
  resting_hr: z.coerce.number().nullable(),
  rhr_mean: z.coerce.number().nullable(),
  rhr_sd: z.coerce.number().nullable(),
  rhr_count: z.coerce.number().nullable(),
  hrv: z.coerce.number().nullable(),
  hrv_mean: z.coerce.number().nullable(),
  hrv_sd: z.coerce.number().nullable(),
  hrv_count: z.coerce.number().nullable(),
  duration_minutes: z.coerce.number().nullable(),
  sleep_mean: z.coerce.number().nullable(),
  sleep_sd: z.coerce.number().nullable(),
  sleep_count: z.coerce.number().nullable(),
});

const anomalyHistoryRowSchema = z.object({
  date: dateStringSchema.nullable(),
  resting_hr: z.coerce.number().nullable(),
  rhr_mean: z.coerce.number().nullable(),
  rhr_sd: z.coerce.number().nullable(),
  rhr_count: z.coerce.number().nullable(),
  hrv: z.coerce.number().nullable(),
  hrv_mean: z.coerce.number().nullable(),
  hrv_sd: z.coerce.number().nullable(),
  hrv_count: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_BASELINE_DAYS = 14;
const WARNING_THRESHOLD = 2;
const ALERT_THRESHOLD = 3;
const BASELINE_LOOKBACK_DAYS = 35;
const BASELINE_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRestingHrAnomaly(
  date: string,
  restingHr: number,
  mean: number,
  stddev: number,
  zScore: number,
): AnomalyRow {
  return {
    date,
    metric: "Resting Heart Rate",
    value: restingHr,
    baselineMean: Math.round(mean * 10) / 10,
    baselineStddev: Math.round(stddev * 10) / 10,
    zScore: Math.round(zScore * 100) / 100,
    severity: zScore > ALERT_THRESHOLD ? "alert" : "warning",
  };
}

function buildHrvAnomaly(
  date: string,
  hrv: number,
  mean: number,
  stddev: number,
  zScore: number,
): AnomalyRow {
  return {
    date,
    metric: "Heart Rate Variability",
    value: hrv,
    baselineMean: Math.round(mean * 10) / 10,
    baselineStddev: Math.round(stddev * 10) / 10,
    zScore: Math.round(zScore * 100) / 100,
    severity: zScore < -ALERT_THRESHOLD ? "alert" : "warning",
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for anomaly detection on daily health metrics. */
export class AnomalyDetectionRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /**
   * Check a single day's health metrics for anomalies by comparing against
   * a rolling 30-day baseline. Flags deviations beyond 2 standard deviations.
   */
  async check(endDate: string): Promise<AnomalyCheckResult> {
    const rows = await executeWithSchema(
      this.#db,
      anomalyCheckRowSchema,
      sql`WITH baseline AS (
            SELECT
              date,
              resting_hr,
              hrv,
              AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_mean,
              STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_sd,
              COUNT(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_count,
              AVG(hrv) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS hrv_mean,
              STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS hrv_sd,
              COUNT(hrv) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS hrv_count
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.#userId}
              AND date > ${dateWindowStart(endDate, BASELINE_LOOKBACK_DAYS)}
            ORDER BY date ASC
          ),
          sleep_raw AS (
            SELECT
              ${sleepNightDate(this.#timezone)} AS date,
              duration_minutes
            FROM fitness.v_sleep
            WHERE user_id = ${this.#userId}
              AND is_nap = false
              AND started_at > ${timestampWindowStart(endDate, BASELINE_LOOKBACK_DAYS)}
          ),
          sleep_nightly AS (
            SELECT DISTINCT ON (date) date, duration_minutes
            FROM sleep_raw
            ORDER BY date, duration_minutes DESC NULLS LAST
          ),
          sleep AS (
            SELECT
              date,
              duration_minutes,
              AVG(duration_minutes) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS sleep_mean,
              STDDEV_POP(duration_minutes) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS sleep_sd,
              COUNT(*) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS sleep_count
            FROM sleep_nightly
            ORDER BY date ASC
          )
          SELECT
            b.date::text,
            b.resting_hr, b.rhr_mean, b.rhr_sd, b.rhr_count,
            b.hrv, b.hrv_mean, b.hrv_sd, b.hrv_count,
            s.duration_minutes, s.sleep_mean, s.sleep_sd, s.sleep_count
          FROM baseline b
          LEFT JOIN sleep s ON s.date = b.date
          WHERE b.date = ${dateWindowEnd(endDate)}
          LIMIT 1`,
    );

    const anomalies: AnomalyRow[] = [];
    const checkedMetrics: string[] = [];

    const row = rows[0];
    if (!row || !row.date) return { anomalies, checkedMetrics };

    const date = String(row.date);

    // Check resting HR (higher = worse)
    if (
      row.resting_hr != null &&
      row.rhr_mean != null &&
      row.rhr_sd != null &&
      Number(row.rhr_sd) > 0 &&
      Number(row.rhr_count) >= MIN_BASELINE_DAYS
    ) {
      checkedMetrics.push("resting_hr");
      const zScore = (Number(row.resting_hr) - Number(row.rhr_mean)) / Number(row.rhr_sd);
      if (zScore > WARNING_THRESHOLD) {
        anomalies.push(
          buildRestingHrAnomaly(
            date,
            Number(row.resting_hr),
            Number(row.rhr_mean),
            Number(row.rhr_sd),
            zScore,
          ),
        );
      }
    }

    // Check HRV (lower = worse, so we check negative z-score)
    if (
      row.hrv != null &&
      row.hrv_mean != null &&
      row.hrv_sd != null &&
      Number(row.hrv_sd) > 0 &&
      Number(row.hrv_count) >= MIN_BASELINE_DAYS
    ) {
      checkedMetrics.push("hrv");
      const zScore = (Number(row.hrv) - Number(row.hrv_mean)) / Number(row.hrv_sd);
      if (zScore < -WARNING_THRESHOLD) {
        anomalies.push(
          buildHrvAnomaly(date, Number(row.hrv), Number(row.hrv_mean), Number(row.hrv_sd), zScore),
        );
      }
    }

    // Check sleep duration (shorter = worse)
    if (
      row.duration_minutes != null &&
      row.sleep_mean != null &&
      row.sleep_sd != null &&
      Number(row.sleep_sd) > 0 &&
      Number(row.sleep_count) >= MIN_BASELINE_DAYS
    ) {
      checkedMetrics.push("sleep_duration");
      const zScore = (Number(row.duration_minutes) - Number(row.sleep_mean)) / Number(row.sleep_sd);
      if (zScore < -WARNING_THRESHOLD) {
        anomalies.push({
          date,
          metric: "Sleep Duration",
          value: Math.round(Number(row.duration_minutes)),
          baselineMean: Math.round(Number(row.sleep_mean)),
          baselineStddev: Math.round(Number(row.sleep_sd)),
          zScore: Math.round(zScore * 100) / 100,
          severity: zScore < -ALERT_THRESHOLD ? "alert" : "warning",
        });
      }
    }

    return { anomalies, checkedMetrics };
  }

  /**
   * Historical anomalies: check each day over a period for deviations.
   * Returns resting HR and HRV anomalies (no sleep) for dashboard markers.
   */
  async getHistory(days: number, _endDate: string): Promise<AnomalyRow[]> {
    const queryDays = days + BASELINE_WINDOW_DAYS;
    const rows = await executeWithSchema(
      this.#db,
      anomalyHistoryRowSchema,
      sql`WITH baseline AS (
            SELECT
              date,
              resting_hr,
              hrv,
              AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_mean,
              STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_sd,
              COUNT(resting_hr) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS rhr_count,
              AVG(hrv) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS hrv_mean,
              STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS hrv_sd,
              COUNT(hrv) OVER (ORDER BY date ROWS BETWEEN ${BASELINE_WINDOW_DAYS} PRECEDING AND 1 PRECEDING) AS hrv_count
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.#userId}
              AND date > CURRENT_DATE - ${queryDays}::int
            ORDER BY date ASC
          )
          SELECT
            date::text,
            resting_hr, rhr_mean, rhr_sd, rhr_count,
            hrv, hrv_mean, hrv_sd, hrv_count
          FROM baseline
          WHERE date > CURRENT_DATE - ${days}::int
          ORDER BY date ASC`,
    );

    const anomalies: AnomalyRow[] = [];

    for (const row of rows) {
      if (!row.date) continue;
      const date = String(row.date);

      // Resting HR
      if (
        row.resting_hr != null &&
        row.rhr_mean != null &&
        row.rhr_sd != null &&
        Number(row.rhr_sd) > 0 &&
        Number(row.rhr_count) >= MIN_BASELINE_DAYS
      ) {
        const restingHrZScore =
          (Number(row.resting_hr) - Number(row.rhr_mean)) / Number(row.rhr_sd);
        if (restingHrZScore > WARNING_THRESHOLD) {
          anomalies.push(
            buildRestingHrAnomaly(
              date,
              Number(row.resting_hr),
              Number(row.rhr_mean),
              Number(row.rhr_sd),
              restingHrZScore,
            ),
          );
        }
      }

      // HRV
      if (
        row.hrv != null &&
        row.hrv_mean != null &&
        row.hrv_sd != null &&
        Number(row.hrv_sd) > 0 &&
        Number(row.hrv_count) >= MIN_BASELINE_DAYS
      ) {
        const hrvZScore = (Number(row.hrv) - Number(row.hrv_mean)) / Number(row.hrv_sd);
        if (hrvZScore < -WARNING_THRESHOLD) {
          anomalies.push(
            buildHrvAnomaly(
              date,
              Number(row.hrv),
              Number(row.hrv_mean),
              Number(row.hrv_sd),
              hrvZScore,
            ),
          );
        }
      }
    }

    return anomalies;
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (re-exported for use outside tRPC context)
// ---------------------------------------------------------------------------

/**
 * Check for anomalies in daily health metrics. Convenience wrapper around
 * the repository for callers that have a full Database handle.
 */
export async function checkAnomalies(
  db: Database,
  userId: string,
  timezone: string,
  endDate: string,
): Promise<AnomalyCheckResult> {
  const repo = new AnomalyDetectionRepository(db, userId, timezone);
  return repo.check(endDate);
}

/**
 * Send anomaly alerts to Slack via the bot. Looks up the Slack user linked
 * to the dofek user and sends a DM with the anomaly details.
 */
export async function sendAnomalyAlertToSlack(
  db: Database,
  userId: string,
  anomalies: AnomalyRow[],
): Promise<boolean> {
  if (anomalies.length === 0) return false;

  // Look up Slack credentials and user link
  const slackRows = await executeWithSchema(
    db,
    z.object({ bot_token: z.string() }),
    sql`SELECT bot_token FROM fitness.slack_installation LIMIT 1`,
  );
  const slackRow = slackRows[0];
  if (!slackRow) {
    logger.debug("[anomaly] No Slack installation found, skipping alert");
    return false;
  }

  const accountRows = await executeWithSchema(
    db,
    z.object({ provider_account_id: z.string() }),
    sql`SELECT provider_account_id FROM fitness.auth_account
        WHERE user_id = ${userId} AND auth_provider = 'slack'
        LIMIT 1`,
  );
  const accountRow = accountRows[0];
  if (!accountRow) {
    logger.debug("[anomaly] No Slack account linked for user, skipping alert");
    return false;
  }

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: anomalies.some((anomaly) => anomaly.severity === "alert")
          ? "Health Alert"
          : "Health Warning",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Unusual readings detected in today's health data:",
      },
    },
    ...anomalies.map((anomaly) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${anomaly.metric}*: ${anomaly.value} (baseline: ${anomaly.baselineMean} \u00b1 ${anomaly.baselineStddev}, z-score: ${anomaly.zScore})`,
      },
    })),
  ];

  // Check for illness pattern: elevated resting HR + depressed HRV
  const hasElevatedHr = anomalies.some((anomaly) => anomaly.metric === "Resting Heart Rate");
  const hasDepressedHrv = anomalies.some((anomaly) => anomaly.metric === "Heart Rate Variability");
  if (hasElevatedHr && hasDepressedHrv) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Combined elevated resting HR and depressed HRV may indicate your body is fighting something. Consider taking it easy today._",
      },
    });
  }

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slackRow.bot_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: accountRow.provider_account_id,
        text: `Health ${anomalies.some((anomaly) => anomaly.severity === "alert") ? "alert" : "warning"}: unusual readings detected`,
        blocks,
      }),
    });

    if (!response.ok) {
      logger.error(`[anomaly] Slack API returned ${response.status}`);
      return false;
    }

    const result: { ok: boolean; error?: string } = await response.json();
    if (!result.ok) {
      logger.error(`[anomaly] Slack API error: ${result.error}`);
      return false;
    }

    logger.info(`[anomaly] Sent ${anomalies.length} alert(s) to Slack for user ${userId}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[anomaly] Failed to send Slack alert: ${message}`);
    return false;
  }
}

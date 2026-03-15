import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

// ── Types ────────────────────────────────────────────────────────────

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

// ── Anomaly Detection Logic ──────────────────────────────────────────

/**
 * Check for anomalies in daily health metrics by comparing today's values
 * against a rolling 30-day baseline. Flags deviations > 2 standard deviations.
 *
 * Checked metrics:
 * - Resting HR (elevated = concern, >2σ = warning, >3σ = alert)
 * - HRV (depressed = concern)
 * - Sleep duration (significantly short)
 *
 * A combination of elevated resting HR + depressed HRV + poor sleep is a
 * known early indicator of illness (WHOOP / Welltory research).
 */
const anomalyCheckRowSchema = z.object({
  date: z.string().nullable(),
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

export async function checkAnomalies(db: Database, userId: string): Promise<AnomalyCheckResult> {
  const rows = await executeWithSchema(
    db,
    anomalyCheckRowSchema,
    sql`WITH baseline AS (
          SELECT
            date,
            resting_hr,
            hrv,
            AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS rhr_mean,
            STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS rhr_sd,
            COUNT(resting_hr) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS rhr_count,
            AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS hrv_mean,
            STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS hrv_sd,
            COUNT(hrv) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS hrv_count
          FROM fitness.v_daily_metrics
          WHERE user_id = ${userId}
            AND date > CURRENT_DATE - 35
          ORDER BY date ASC
        ),
        sleep AS (
          SELECT
            started_at::date AS date,
            duration_minutes,
            AVG(duration_minutes) OVER (ORDER BY started_at::date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS sleep_mean,
            STDDEV_POP(duration_minutes) OVER (ORDER BY started_at::date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS sleep_sd,
            COUNT(*) OVER (ORDER BY started_at::date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS sleep_count
          FROM fitness.v_sleep
          WHERE user_id = ${userId}
            AND is_nap = false
            AND started_at > NOW() - INTERVAL '35 days'
          ORDER BY started_at ASC
        )
        SELECT
          b.date::text,
          b.resting_hr, b.rhr_mean, b.rhr_sd, b.rhr_count,
          b.hrv, b.hrv_mean, b.hrv_sd, b.hrv_count,
          s.duration_minutes, s.sleep_mean, s.sleep_sd, s.sleep_count
        FROM baseline b
        LEFT JOIN sleep s ON s.date = b.date
        WHERE b.date = CURRENT_DATE
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
    Number(row.rhr_count) >= 14
  ) {
    checkedMetrics.push("resting_hr");
    const zScore = (Number(row.resting_hr) - Number(row.rhr_mean)) / Number(row.rhr_sd);
    if (zScore > 2) {
      anomalies.push({
        date,
        metric: "Resting Heart Rate",
        value: Number(row.resting_hr),
        baselineMean: Math.round(Number(row.rhr_mean) * 10) / 10,
        baselineStddev: Math.round(Number(row.rhr_sd) * 10) / 10,
        zScore: Math.round(zScore * 100) / 100,
        severity: zScore > 3 ? "alert" : "warning",
      });
    }
  }

  // Check HRV (lower = worse, so we check negative z-score)
  if (
    row.hrv != null &&
    row.hrv_mean != null &&
    row.hrv_sd != null &&
    Number(row.hrv_sd) > 0 &&
    Number(row.hrv_count) >= 14
  ) {
    checkedMetrics.push("hrv");
    const zScore = (Number(row.hrv) - Number(row.hrv_mean)) / Number(row.hrv_sd);
    if (zScore < -2) {
      anomalies.push({
        date,
        metric: "Heart Rate Variability",
        value: Number(row.hrv),
        baselineMean: Math.round(Number(row.hrv_mean) * 10) / 10,
        baselineStddev: Math.round(Number(row.hrv_sd) * 10) / 10,
        zScore: Math.round(zScore * 100) / 100,
        severity: zScore < -3 ? "alert" : "warning",
      });
    }
  }

  // Check sleep duration (shorter = worse)
  if (
    row.duration_minutes != null &&
    row.sleep_mean != null &&
    row.sleep_sd != null &&
    Number(row.sleep_sd) > 0 &&
    Number(row.sleep_count) >= 14
  ) {
    checkedMetrics.push("sleep_duration");
    const zScore = (Number(row.duration_minutes) - Number(row.sleep_mean)) / Number(row.sleep_sd);
    if (zScore < -2) {
      anomalies.push({
        date,
        metric: "Sleep Duration",
        value: Math.round(Number(row.duration_minutes)),
        baselineMean: Math.round(Number(row.sleep_mean)),
        baselineStddev: Math.round(Number(row.sleep_sd)),
        zScore: Math.round(zScore * 100) / 100,
        severity: zScore < -3 ? "alert" : "warning",
      });
    }
  }

  return { anomalies, checkedMetrics };
}

// ── Slack Notification ───────────────────────────────────────────────

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
        text: anomalies.some((a) => a.severity === "alert") ? "Health Alert" : "Health Warning",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Unusual readings detected in today's health data:",
      },
    },
    ...anomalies.map((a) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${a.metric}*: ${a.value} (baseline: ${a.baselineMean} ± ${a.baselineStddev}, z-score: ${a.zScore})`,
      },
    })),
  ];

  // Check for illness pattern: elevated resting HR + depressed HRV
  const hasElevatedHr = anomalies.some((a) => a.metric === "Resting Heart Rate");
  const hasDepressedHrv = anomalies.some((a) => a.metric === "Heart Rate Variability");
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
        text: `Health ${anomalies.some((a) => a.severity === "alert") ? "alert" : "warning"}: unusual readings detected`,
        blocks,
      }),
    });

    if (!response.ok) {
      logger.error(`[anomaly] Slack API returned ${response.status}`);
      return false;
    }

    const result = (await response.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.error(`[anomaly] Slack API error: ${result.error}`);
      return false;
    }

    logger.info(`[anomaly] Sent ${anomalies.length} alert(s) to Slack for user ${userId}`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[anomaly] Failed to send Slack alert: ${msg}`);
    return false;
  }
}

// ── Router ───────────────────────────────────────────────────────────

export const anomalyDetectionRouter = router({
  /**
   * Check today's health metrics for anomalies.
   * Returns any metrics that deviate significantly from the 30-day baseline.
   */
  check: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({}).default({}))
    .query(async ({ ctx }): Promise<AnomalyCheckResult> => {
      return checkAnomalies(ctx.db, ctx.userId);
    }),

  /**
   * Historical anomalies: check each day over a period for deviations.
   * Useful for the dashboard to show anomaly markers on time-series charts.
   */
  history: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<AnomalyRow[]> => {
      const queryDays = input.days + 30;
      const anomalyHistoryRowSchema = z.object({
        date: z.string().nullable(),
        resting_hr: z.coerce.number().nullable(),
        rhr_mean: z.coerce.number().nullable(),
        rhr_sd: z.coerce.number().nullable(),
        rhr_count: z.coerce.number().nullable(),
        hrv: z.coerce.number().nullable(),
        hrv_mean: z.coerce.number().nullable(),
        hrv_sd: z.coerce.number().nullable(),
        hrv_count: z.coerce.number().nullable(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        anomalyHistoryRowSchema,
        sql`WITH baseline AS (
              SELECT
                date,
                resting_hr,
                hrv,
                AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS rhr_mean,
                STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS rhr_sd,
                COUNT(resting_hr) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS rhr_count,
                AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS hrv_mean,
                STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS hrv_sd,
                COUNT(hrv) OVER (ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS hrv_count
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${queryDays}::int
              ORDER BY date ASC
            )
            SELECT
              date::text,
              resting_hr, rhr_mean, rhr_sd, rhr_count,
              hrv, hrv_mean, hrv_sd, hrv_count
            FROM baseline
            WHERE date > CURRENT_DATE - ${input.days}::int
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
          Number(row.rhr_count) >= 14
        ) {
          const z = (Number(row.resting_hr) - Number(row.rhr_mean)) / Number(row.rhr_sd);
          if (z > 2) {
            anomalies.push({
              date,
              metric: "Resting Heart Rate",
              value: Number(row.resting_hr),
              baselineMean: Math.round(Number(row.rhr_mean) * 10) / 10,
              baselineStddev: Math.round(Number(row.rhr_sd) * 10) / 10,
              zScore: Math.round(z * 100) / 100,
              severity: z > 3 ? "alert" : "warning",
            });
          }
        }

        // HRV
        if (
          row.hrv != null &&
          row.hrv_mean != null &&
          row.hrv_sd != null &&
          Number(row.hrv_sd) > 0 &&
          Number(row.hrv_count) >= 14
        ) {
          const z = (Number(row.hrv) - Number(row.hrv_mean)) / Number(row.hrv_sd);
          if (z < -2) {
            anomalies.push({
              date,
              metric: "Heart Rate Variability",
              value: Number(row.hrv),
              baselineMean: Math.round(Number(row.hrv_mean) * 10) / 10,
              baselineStddev: Math.round(Number(row.hrv_sd) * 10) / 10,
              zScore: Math.round(z * 100) / 100,
              severity: z < -3 ? "alert" : "warning",
            });
          }
        }
      }

      return anomalies;
    }),
});

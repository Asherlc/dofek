import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { type AnomalyRow, checkAnomalies, sendAnomalyAlertToSlack } from "./anomaly-detection.ts";

const mswServer = setupServer();

/**
 * Unit tests for the anomaly detection logic (checkAnomalies)
 * and the Slack notification function (sendAnomalyAlertToSlack).
 *
 * checkAnomalies is SQL-based and returns empty results on an empty DB,
 * so we focus on testing the Slack notification path and the anomaly
 * row processing logic via sendAnomalyAlertToSlack.
 */
describe("Anomaly detection", () => {
  let testCtx: TestContext;

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    testCtx = await setupTestDatabase();
  }, 120_000);

  afterEach(() => {
    mswServer.resetHandlers();
  });

  afterAll(async () => {
    mswServer.close();
    await testCtx?.cleanup();
  });

  describe("checkAnomalies", () => {
    it("returns empty anomalies and checkedMetrics on empty database", async () => {
      const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
      const result = await checkAnomalies(testCtx.db, TEST_USER_ID, "UTC", "2026-03-13");

      expect(result.anomalies).toEqual([]);
      expect(result.checkedMetrics).toEqual([]);
    });
  });

  describe("sendAnomalyAlertToSlack", () => {
    const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

    it("returns false when anomalies array is empty", async () => {
      const result = await sendAnomalyAlertToSlack(testCtx.db, TEST_USER_ID, []);
      expect(result).toBe(false);
    });

    it("returns false when no Slack installation exists", async () => {
      const anomalies: AnomalyRow[] = [
        {
          date: "2026-03-13",
          metric: "Resting Heart Rate",
          value: 72,
          baselineMean: 58,
          baselineStddev: 4,
          zScore: 3.5,
          severity: "alert",
        },
      ];

      const result = await sendAnomalyAlertToSlack(testCtx.db, TEST_USER_ID, anomalies);
      expect(result).toBe(false);
    });

    it("returns false when Slack installation exists but no linked Slack account", async () => {
      // Insert a Slack installation
      const { sql } = await import("drizzle-orm");
      await testCtx.db.execute(
        sql`INSERT INTO fitness.slack_installation (team_id, team_name, bot_token, app_id, raw_installation)
            VALUES ('T-TEST', 'Test Team', 'xoxb-test-token', 'A-TEST', '{}')
            ON CONFLICT (team_id) DO NOTHING`,
      );

      const anomalies: AnomalyRow[] = [
        {
          date: "2026-03-13",
          metric: "Heart Rate Variability",
          value: 25,
          baselineMean: 50,
          baselineStddev: 8,
          zScore: -3.13,
          severity: "alert",
        },
      ];

      const result = await sendAnomalyAlertToSlack(testCtx.db, TEST_USER_ID, anomalies);
      expect(result).toBe(false);

      // Cleanup
      await testCtx.db.execute(
        sql`DELETE FROM fitness.slack_installation WHERE team_id = 'T-TEST'`,
      );
    });

    it("calls Slack API and returns true on success", async () => {
      const { sql } = await import("drizzle-orm");

      // Insert Slack installation
      await testCtx.db.execute(
        sql`INSERT INTO fitness.slack_installation (team_id, team_name, bot_token, app_id, raw_installation)
            VALUES ('T-TEST-2', 'Test Team', 'xoxb-test-token', 'A-TEST', '{}')
            ON CONFLICT (team_id) DO NOTHING`,
      );

      // Link Slack account to user
      await testCtx.db.execute(
        sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, name)
            VALUES (${TEST_USER_ID}, 'slack', 'U_SLACK_ALERT', 'Alert User')
            ON CONFLICT DO NOTHING`,
      );

      const anomalies: AnomalyRow[] = [
        {
          date: "2026-03-13",
          metric: "Resting Heart Rate",
          value: 72,
          baselineMean: 58,
          baselineStddev: 4,
          zScore: 3.5,
          severity: "alert",
        },
        {
          date: "2026-03-13",
          metric: "Heart Rate Variability",
          value: 25,
          baselineMean: 50,
          baselineStddev: 8,
          zScore: -3.13,
          severity: "alert",
        },
      ];

      let capturedBody = "";

      mswServer.use(
        http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
          capturedBody = await request.text();
          return HttpResponse.json({ ok: true });
        }),
      );

      try {
        const result = await sendAnomalyAlertToSlack(testCtx.db, TEST_USER_ID, anomalies);
        expect(result).toBe(true);

        // Verify the body includes illness pattern warning
        const callBody = JSON.parse(capturedBody);
        const blockTexts = callBody.blocks.map(
          (b: { text?: { text?: string } }) => b.text?.text ?? "",
        );
        const hasIllnessWarning = blockTexts.some((t: string) => t.includes("fighting something"));
        expect(hasIllnessWarning).toBe(true);
      } finally {
        await testCtx.db.execute(
          sql`DELETE FROM fitness.auth_account WHERE provider_account_id = 'U_SLACK_ALERT'`,
        );
        await testCtx.db.execute(
          sql`DELETE FROM fitness.slack_installation WHERE team_id = 'T-TEST-2'`,
        );
      }
    });

    it("returns false when Slack API returns non-ok HTTP status", async () => {
      const { sql } = await import("drizzle-orm");

      await testCtx.db.execute(
        sql`INSERT INTO fitness.slack_installation (team_id, team_name, bot_token, app_id, raw_installation)
            VALUES ('T-TEST-3', 'Test Team', 'xoxb-test-token', 'A-TEST', '{}')
            ON CONFLICT (team_id) DO NOTHING`,
      );

      await testCtx.db.execute(
        sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, name)
            VALUES (${TEST_USER_ID}, 'slack', 'U_SLACK_FAIL', 'Fail User')
            ON CONFLICT DO NOTHING`,
      );

      const anomalies: AnomalyRow[] = [
        {
          date: "2026-03-13",
          metric: "Sleep Duration",
          value: 280,
          baselineMean: 420,
          baselineStddev: 40,
          zScore: -3.5,
          severity: "alert",
        },
      ];

      mswServer.use(
        http.post("https://slack.com/api/chat.postMessage", () => {
          return new HttpResponse("Internal Server Error", { status: 500 });
        }),
      );

      try {
        const result = await sendAnomalyAlertToSlack(testCtx.db, TEST_USER_ID, anomalies);
        expect(result).toBe(false);
      } finally {
        await testCtx.db.execute(
          sql`DELETE FROM fitness.auth_account WHERE provider_account_id = 'U_SLACK_FAIL'`,
        );
        await testCtx.db.execute(
          sql`DELETE FROM fitness.slack_installation WHERE team_id = 'T-TEST-3'`,
        );
      }
    });

    it("returns false when Slack API returns ok:false", async () => {
      const { sql } = await import("drizzle-orm");

      await testCtx.db.execute(
        sql`INSERT INTO fitness.slack_installation (team_id, team_name, bot_token, app_id, raw_installation)
            VALUES ('T-TEST-4', 'Test Team', 'xoxb-test-token', 'A-TEST', '{}')
            ON CONFLICT (team_id) DO NOTHING`,
      );

      await testCtx.db.execute(
        sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, name)
            VALUES (${TEST_USER_ID}, 'slack', 'U_SLACK_ERR', 'Error User')
            ON CONFLICT DO NOTHING`,
      );

      const anomalies: AnomalyRow[] = [
        {
          date: "2026-03-13",
          metric: "Resting Heart Rate",
          value: 68,
          baselineMean: 55,
          baselineStddev: 4,
          zScore: 3.25,
          severity: "alert",
        },
      ];

      mswServer.use(
        http.post("https://slack.com/api/chat.postMessage", () => {
          return HttpResponse.json({ ok: false, error: "channel_not_found" });
        }),
      );

      try {
        const result = await sendAnomalyAlertToSlack(testCtx.db, TEST_USER_ID, anomalies);
        expect(result).toBe(false);
      } finally {
        await testCtx.db.execute(
          sql`DELETE FROM fitness.auth_account WHERE provider_account_id = 'U_SLACK_ERR'`,
        );
        await testCtx.db.execute(
          sql`DELETE FROM fitness.slack_installation WHERE team_id = 'T-TEST-4'`,
        );
      }
    });

    it("returns false when fetch throws a network error", async () => {
      const { sql } = await import("drizzle-orm");

      await testCtx.db.execute(
        sql`INSERT INTO fitness.slack_installation (team_id, team_name, bot_token, app_id, raw_installation)
            VALUES ('T-TEST-5', 'Test Team', 'xoxb-test-token', 'A-TEST', '{}')
            ON CONFLICT (team_id) DO NOTHING`,
      );

      await testCtx.db.execute(
        sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, name)
            VALUES (${TEST_USER_ID}, 'slack', 'U_SLACK_NET', 'Net User')
            ON CONFLICT DO NOTHING`,
      );

      const anomalies: AnomalyRow[] = [
        {
          date: "2026-03-13",
          metric: "Resting Heart Rate",
          value: 70,
          baselineMean: 55,
          baselineStddev: 4,
          zScore: 3.75,
          severity: "alert",
        },
      ];

      mswServer.use(
        http.post("https://slack.com/api/chat.postMessage", () => {
          return HttpResponse.error();
        }),
      );

      try {
        const result = await sendAnomalyAlertToSlack(testCtx.db, TEST_USER_ID, anomalies);
        expect(result).toBe(false);
      } finally {
        await testCtx.db.execute(
          sql`DELETE FROM fitness.auth_account WHERE provider_account_id = 'U_SLACK_NET'`,
        );
        await testCtx.db.execute(
          sql`DELETE FROM fitness.slack_installation WHERE team_id = 'T-TEST-5'`,
        );
      }
    });

    it("includes warning severity in message text when no alerts", async () => {
      const { sql } = await import("drizzle-orm");

      await testCtx.db.execute(
        sql`INSERT INTO fitness.slack_installation (team_id, team_name, bot_token, app_id, raw_installation)
            VALUES ('T-TEST-6', 'Test Team', 'xoxb-test-token', 'A-TEST', '{}')
            ON CONFLICT (team_id) DO NOTHING`,
      );

      await testCtx.db.execute(
        sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, name)
            VALUES (${TEST_USER_ID}, 'slack', 'U_SLACK_WARN', 'Warn User')
            ON CONFLICT DO NOTHING`,
      );

      const anomalies: AnomalyRow[] = [
        {
          date: "2026-03-13",
          metric: "Resting Heart Rate",
          value: 66,
          baselineMean: 55,
          baselineStddev: 4,
          zScore: 2.75,
          severity: "warning",
        },
      ];

      let capturedBody = "";

      mswServer.use(
        http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
          capturedBody = await request.text();
          return HttpResponse.json({ ok: true });
        }),
      );

      try {
        const result = await sendAnomalyAlertToSlack(testCtx.db, TEST_USER_ID, anomalies);
        expect(result).toBe(true);

        const callBody = JSON.parse(capturedBody);
        // Warning header (not alert)
        expect(callBody.blocks[0].text.text).toBe("Health Warning");
        expect(callBody.text).toContain("warning");
      } finally {
        await testCtx.db.execute(
          sql`DELETE FROM fitness.auth_account WHERE provider_account_id = 'U_SLACK_WARN'`,
        );
        await testCtx.db.execute(
          sql`DELETE FROM fitness.slack_installation WHERE team_id = 'T-TEST-6'`,
        );
      }
    });
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  setupTestDatabase,
  type TestContext,
} from "../../../../../src/db/__tests__/test-helpers.ts";
import { type AnomalyRow, checkAnomalies, sendAnomalyAlertToSlack } from "../anomaly-detection.ts";

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
    testCtx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await testCtx?.cleanup();
  });

  describe("checkAnomalies", () => {
    it("returns empty anomalies and checkedMetrics on empty database", async () => {
      const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
      const result = await checkAnomalies(testCtx.db, DEFAULT_USER_ID);

      expect(result.anomalies).toEqual([]);
      expect(result.checkedMetrics).toEqual([]);
    });
  });

  describe("sendAnomalyAlertToSlack", () => {
    const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

    it("returns false when anomalies array is empty", async () => {
      const result = await sendAnomalyAlertToSlack(testCtx.db, DEFAULT_USER_ID, []);
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

      const result = await sendAnomalyAlertToSlack(testCtx.db, DEFAULT_USER_ID, anomalies);
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

      const result = await sendAnomalyAlertToSlack(testCtx.db, DEFAULT_USER_ID, anomalies);
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
            VALUES (${DEFAULT_USER_ID}, 'slack', 'U_SLACK_ALERT', 'Alert User')
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

      // Mock global fetch to simulate Slack API success
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      }) as unknown as typeof fetch;

      try {
        const result = await sendAnomalyAlertToSlack(testCtx.db, DEFAULT_USER_ID, anomalies);
        expect(result).toBe(true);

        // Verify fetch was called with correct params
        const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
        expect(mockFetch).toHaveBeenCalledWith(
          "https://slack.com/api/chat.postMessage",
          expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              Authorization: "Bearer xoxb-test-token",
            }),
          }),
        );

        // Verify the body includes illness pattern warning
        const callBody = JSON.parse(
          (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
        );
        const blockTexts = callBody.blocks.map(
          (b: { text?: { text?: string } }) => b.text?.text ?? "",
        );
        const hasIllnessWarning = blockTexts.some((t: string) => t.includes("fighting something"));
        expect(hasIllnessWarning).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
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
            VALUES (${DEFAULT_USER_ID}, 'slack', 'U_SLACK_FAIL', 'Fail User')
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

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }) as unknown as typeof fetch;

      try {
        const result = await sendAnomalyAlertToSlack(testCtx.db, DEFAULT_USER_ID, anomalies);
        expect(result).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
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
            VALUES (${DEFAULT_USER_ID}, 'slack', 'U_SLACK_ERR', 'Error User')
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

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: "channel_not_found" }),
      }) as unknown as typeof fetch;

      try {
        const result = await sendAnomalyAlertToSlack(testCtx.db, DEFAULT_USER_ID, anomalies);
        expect(result).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
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
            VALUES (${DEFAULT_USER_ID}, 'slack', 'U_SLACK_NET', 'Net User')
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

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Network error")) as unknown as typeof fetch;

      try {
        const result = await sendAnomalyAlertToSlack(testCtx.db, DEFAULT_USER_ID, anomalies);
        expect(result).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
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
            VALUES (${DEFAULT_USER_ID}, 'slack', 'U_SLACK_WARN', 'Warn User')
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

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      }) as unknown as typeof fetch;

      try {
        const result = await sendAnomalyAlertToSlack(testCtx.db, DEFAULT_USER_ID, anomalies);
        expect(result).toBe(true);

        const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
        const callBody = JSON.parse(
          (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
        );
        // Warning header (not alert)
        expect(callBody.blocks[0].text.text).toBe("Health Warning");
        expect(callBody.text).toContain("warning");
      } finally {
        globalThis.fetch = originalFetch;
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

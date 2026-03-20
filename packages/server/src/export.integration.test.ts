import type { Server } from "node:http";
import { Worker } from "bullmq";
import { DEFAULT_USER_ID } from "dofek/db/schema";
import { processExportJob } from "dofek/jobs/process-export-job";
import type { ExportJobData } from "dofek/jobs/queues";
import { EXPORT_QUEUE, getRedisConnection } from "dofek/jobs/queues";
import { sql } from "drizzle-orm";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../src/db/test-helpers.ts";
import { createSession } from "./auth/session.ts";
import { createApp } from "./index.ts";

/** Safely read a file from a JSZip instance, failing the test if missing. */
async function readZipFile(zip: JSZip, name: string): Promise<string> {
  const file = zip.files[name];
  if (!file) throw new Error(`Expected ${name} in ZIP`);
  return file.async("string");
}

describe("Data Export", () => {
  let testCtx: TestContext;
  let server: Server;
  let baseUrl: string;
  let sessionCookie: string;
  let exportWorker: Worker<ExportJobData>;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    // Start an in-process BullMQ worker so export jobs are processed
    // without needing the Docker worker container.
    const connection = getRedisConnection();
    exportWorker = new Worker<ExportJobData>(
      EXPORT_QUEUE,
      (job) => processExportJob(job, testCtx.db),
      { connection },
    );

    // Create a provider for seeding data
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id) VALUES ('test-provider', 'Test Provider', ${DEFAULT_USER_ID})`,
    );

    // Seed test data across all tables
    await Promise.all([
      // Activity
      testCtx.db.execute(
        sql`INSERT INTO fitness.activity (id, provider_id, user_id, activity_type, started_at, name, raw)
            VALUES ('11111111-1111-1111-1111-111111111111', 'test-provider', ${DEFAULT_USER_ID}, 'cycling', '2024-01-15T10:00:00Z', 'Morning Ride', '{"source": "test"}'::jsonb)`,
      ),
      // Sleep
      testCtx.db.execute(
        sql`INSERT INTO fitness.sleep_session (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, deep_minutes)
            VALUES ('test-provider', ${DEFAULT_USER_ID}, 'sleep-1', '2024-01-15T22:00:00Z', '2024-01-16T06:00:00Z', 480, 90)`,
      ),
      // Body measurement
      testCtx.db.execute(
        sql`INSERT INTO fitness.body_measurement (provider_id, user_id, external_id, recorded_at, weight_kg)
            VALUES ('test-provider', ${DEFAULT_USER_ID}, 'bm-1', '2024-01-15T08:00:00Z', 75.5)`,
      ),
      // Nutrition daily
      testCtx.db.execute(
        sql`INSERT INTO fitness.nutrition_daily (date, provider_id, user_id, calories, protein_g)
            VALUES ('2024-01-15', 'test-provider', ${DEFAULT_USER_ID}, 2200, 120)`,
      ),
      // Daily metrics
      testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, resting_hr, hrv, steps)
            VALUES ('2024-01-15', 'test-provider', ${DEFAULT_USER_ID}, 52, 65.2, 8500)`,
      ),
      // Journal entry
      testCtx.db.execute(
        sql`INSERT INTO fitness.journal_entry (date, provider_id, user_id, question, answer_text)
            VALUES ('2024-01-15', 'test-provider', ${DEFAULT_USER_ID}, 'How did you sleep?', 'Great')`,
      ),
      // Life event
      testCtx.db.execute(
        sql`INSERT INTO fitness.life_events (user_id, label, started_at, category)
            VALUES (${DEFAULT_USER_ID}, 'Started new program', '2024-01-15', 'training')`,
      ),
      // Metric stream
      testCtx.db.execute(
        sql`INSERT INTO fitness.metric_stream (recorded_at, user_id, activity_id, provider_id, heart_rate, power)
            VALUES ('2024-01-15T10:00:00Z', ${DEFAULT_USER_ID}, '11111111-1111-1111-1111-111111111111', 'test-provider', 145, 200)`,
      ),
    ]);

    // Activity interval (depends on activity existing)
    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity_interval (activity_id, interval_index, started_at)
          VALUES ('11111111-1111-1111-1111-111111111111', 0, '2024-01-15T10:00:00Z')`,
    );

    // Create session
    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Start server
    const app = createApp(testCtx.db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (exportWorker) await exportWorker.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  it("triggers an export and returns a jobId", async () => {
    const res = await fetch(`${baseUrl}/api/export`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body: { status: string; jobId: string } = await res.json();
    expect(body.status).toBe("processing");
    expect(body.jobId).toBeTruthy();
  });

  it("returns 401 for unauthenticated export request", async () => {
    const res = await fetch(`${baseUrl}/api/export`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown jobId on status", async () => {
    const res = await fetch(`${baseUrl}/api/export/status/nonexistent`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(404);
  });

  it("completes export and produces a valid ZIP with all data types", async () => {
    // Trigger export
    const triggerRes = await fetch(`${baseUrl}/api/export`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
    const { jobId }: { jobId: string } = await triggerRes.json();

    // Poll until done (max 30 seconds)
    let status: { status: string; downloadUrl?: string } = { status: "processing" };
    const deadline = Date.now() + 30_000;
    while (status.status === "processing" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const statusRes = await fetch(`${baseUrl}/api/export/status/${jobId}`, {
        headers: { Cookie: sessionCookie },
      });
      status = await statusRes.json();
    }

    expect(status.status).toBe("done");
    expect(status.downloadUrl).toBeTruthy();

    // Download the ZIP
    const downloadRes = await fetch(`${baseUrl}${status.downloadUrl}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toContain("application/zip");

    // Parse the ZIP
    const zipBuffer = await downloadRes.arrayBuffer();
    const zip = await JSZip.loadAsync(zipBuffer);

    // Verify expected files exist
    const expectedFiles = [
      "activities.json",
      "activity-intervals.json",
      "sleep-sessions.json",
      "body-measurements.json",
      "nutrition-daily.json",
      "daily-metrics.json",
      "journal-entries.json",
      "life-events.json",
      "metric-streams.json",
      "export-metadata.json",
      "user-profile.json",
      "sport-settings.json",
      "health-events.json",
      "food-entries.json",
      "lab-results.json",
      "strength-workouts.json",
      "strength-sets.json",
    ];

    for (const file of expectedFiles) {
      expect(zip.files[file], `Expected ${file} in ZIP`).toBeDefined();
    }

    // Verify activities contain data
    const activitiesJson = await readZipFile(zip, "activities.json");
    const activities: Array<Record<string, unknown>> = JSON.parse(activitiesJson);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ name: "Morning Ride", raw: { source: "test" } });

    // Verify metric streams contain data
    const metricStreamsJson = await readZipFile(zip, "metric-streams.json");
    const metricStreams: Array<Record<string, unknown>> = JSON.parse(metricStreamsJson);
    expect(metricStreams).toHaveLength(1);
    expect(metricStreams[0]).toMatchObject({ heart_rate: 145 });

    // Verify metadata
    const metadataJson = await readZipFile(zip, "export-metadata.json");
    const metadata: {
      exportedAt: string;
      userId: string;
      totalRecords: number;
    } = JSON.parse(metadataJson);
    expect(metadata.userId).toBe(DEFAULT_USER_ID);
    expect(metadata.totalRecords).toBeGreaterThan(0);
    expect(metadata.exportedAt).toBeTruthy();
  }, 60_000);

  it("returns 401 for unauthenticated download", async () => {
    // Trigger an export first
    const triggerRes = await fetch(`${baseUrl}/api/export`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
    const { jobId }: { jobId: string } = await triggerRes.json();

    // Try to download without auth
    const downloadRes = await fetch(`${baseUrl}/api/export/download/${jobId}`);
    expect(downloadRes.status).toBe(401);
  });

  it("scopes exported data to the authenticated user", async () => {
    // Insert data for a different user
    const otherUserId = "22222222-2222-2222-2222-222222222222";
    await testCtx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${otherUserId}, 'Other User') ON CONFLICT (id) DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id) VALUES ('other-provider', 'Other Provider', ${otherUserId}) ON CONFLICT (id) DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity (provider_id, user_id, activity_type, started_at, name)
          VALUES ('other-provider', ${otherUserId}, 'running', '2024-01-15T10:00:00Z', 'Secret Run')`,
    );

    // Trigger export as default user
    const triggerRes = await fetch(`${baseUrl}/api/export`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
    const { jobId }: { jobId: string } = await triggerRes.json();

    // Poll until done
    let status: { status: string; downloadUrl?: string } = { status: "processing" };
    const deadline = Date.now() + 30_000;
    while (status.status === "processing" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const statusRes = await fetch(`${baseUrl}/api/export/status/${jobId}`, {
        headers: { Cookie: sessionCookie },
      });
      status = await statusRes.json();
    }

    expect(status.status).toBe("done");

    // Download and check activities
    const downloadRes = await fetch(`${baseUrl}${status.downloadUrl}`, {
      headers: { Cookie: sessionCookie },
    });
    const zip = await JSZip.loadAsync(await downloadRes.arrayBuffer());
    const activitiesJson = await readZipFile(zip, "activities.json");
    const activities: Array<Record<string, unknown>> = JSON.parse(activitiesJson);

    // Should only contain the default user's activity, not "Secret Run"
    expect(activities.every((a) => a.user_id === DEFAULT_USER_ID)).toBe(true);
    expect(activities.find((a) => a.name === "Secret Run")).toBeUndefined();
  }, 60_000);
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import yauzl from "yauzl";
import { seedOwnedClimbingGraph } from "./db/climbing-lifecycle-test-helpers.ts";
import { setupTestDatabase } from "./db/test-helpers.ts";
import { ensureProvider } from "./db/tokens.ts";
import { generateExport } from "./export.ts";

function zipContents(path: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("Missing ZIP archive"));
        return;
      }
      const contents = new Map<string, string>();
      zip.on("error", reject);
      zip.on("end", () => resolve(contents));
      zip.on("entry", (entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            zip.close();
            reject(error ?? new Error("Missing ZIP entry stream"));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            contents.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    }),
  );
}
it("exports the complete owned climbing graph with native points, unknown dates and retained records", async () => {
  const context = await setupTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), "climbing-export-test-"));
  try {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const graph = await seedOwnedClimbingGraph(context.db, owner, "export-climbing");
    const other = await seedOwnedClimbingGraph(context.db, otherOwner, "export-climbing");
    const archive = join(directory, "owned.zip");
    await generateExport(context.db, owner, archive, () => {});
    const files = await zipContents(archive);
    const names = [
      "areas.csv",
      "climbs.csv",
      "pitches.csv",
      "climb-grades.csv",
      "pitch-grades.csv",
      "climbing-log-entry-grades.csv",
      "climbing-log-entries.csv",
      "climbing-attempts.csv",
    ];
    expect([...files.keys()]).toEqual(expect.arrayContaining(names));
    expect(files.get("climbs.csv")).toContain('"(-122.25,37.5)"');
    expect(files.get("areas.csv")).toContain('"(0,0)"');
    expect(files.get("pitches.csv")).toContain(graph.pitch);
    expect(files.get("climb-grades.csv")).toContain("5.10a");
    expect(files.get("pitch-grades.csv")).toContain("A2");
    expect(files.get("climbing-log-entry-grades.csv")).toContain("5.10b");
    expect(files.get("climbing-log-entries.csv")).toContain(graph.log);
    expect(files.get("climbing-log-entries.csv")).toContain("Retained source note");
    expect(files.get("climbing-log-entries.csv")).toContain("Retained raw payload");
    expect(files.get("climbing-attempts.csv")).toContain(graph.whole);
    expect(files.get("climbing-attempts.csv")).toContain(graph.child);
    for (const name of names) expect(files.get(name)).not.toContain(other.log);
    expect(files.get("climbs.csv")).not.toContain(other.climb);
    expect(files.get("pitches.csv")).not.toContain(other.pitch);
    expect(files.get("areas.csv")).not.toContain(other.area);
    expect(files.get("climb-grades.csv")).not.toContain(other.climb);
    expect(files.get("pitch-grades.csv")).not.toContain(other.pitch);
    const attemptLines = files.get("climbing-attempts.csv")?.split("\n") ?? [];
    const header = attemptLines[0]?.split(",") ?? [];
    const whole = attemptLines.find((line) => line.startsWith(graph.whole))?.split(",") ?? [];
    const child = attemptLines.find((line) => line.startsWith(graph.child))?.split(",") ?? [];
    expect(whole[header.indexOf("used_aid")]).toBe("true");
    expect(child[header.indexOf("scope")]).toBe("pitch");
    expect(child[header.indexOf("pitch_id")]).toBe(graph.pitch);
    expect(child[header.indexOf("parent_attempt_id")]).toBe(graph.whole);
  } finally {
    await context.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

it("exports only the owner's date-only daily metric catalog values with provider, unit and date", async () => {
  const context = await setupTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), "daily-metric-values-export-test-"));
  try {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${owner}::uuid, 'Export Owner'), (${otherOwner}::uuid, 'Export Other')`,
    );
    await ensureProvider(context.db, "intervals.icu", "Intervals.icu", "https://intervals.icu");
    for (const [user, weight] of [
      [owner, 70.5],
      [otherOwner, 123.4],
    ] as const) {
      await context.db.execute(
        sql`WITH parent AS (
              INSERT INTO fitness.daily_metrics (date, provider_id, user_id)
              VALUES ('2026-03-01', 'intervals.icu', ${user}::uuid) RETURNING id
            )
            INSERT INTO fitness.daily_metric_value (daily_metrics_id, metric_type_id, value)
            SELECT id, 'weight', ${weight} FROM parent`,
      );
    }
    const archive = join(directory, "values.zip");
    await generateExport(context.db, owner, archive, () => {});
    const csv = (await zipContents(archive)).get("daily-metric-values.csv");

    expect(csv).toContain("intervals.icu");
    expect(csv).toContain("2026-03-01");
    expect(csv).toContain("weight");
    expect(csv).toContain("kg");
    expect(csv).toContain("70.5");
    expect(csv).not.toContain("123.4");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await context.cleanup();
  }
});

it("exports only the owner's planned workouts with their native workout document", async () => {
  const context = await setupTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), "planned-workout-export-test-"));
  try {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${owner}::uuid, 'Planned Export Owner'), (${otherOwner}::uuid, 'Planned Export Other')`,
    );
    await ensureProvider(context.db, "intervals.icu", "Intervals.icu", "https://intervals.icu");
    for (const [user, externalId, title, doc] of [
      [owner, "own-session", "Owner Ramp", { steps: [{ duration: 600 }] }],
      [otherOwner, "other-session", "Other Ramp", { steps: [{ duration: 300 }] }],
    ] as const) {
      await context.db.execute(
        sql`INSERT INTO fitness.planned_workout
              (user_id, provider_id, external_id, start_date, start_time, title, sport_type, workout_doc)
            VALUES (${user}::uuid, 'intervals.icu', ${externalId}, '2026-03-10', '06:30:00',
              ${title}, 'Ride', ${JSON.stringify(doc)}::jsonb)`,
      );
    }
    const archive = join(directory, "planned.zip");
    await generateExport(context.db, owner, archive, () => {});
    const csv = (await zipContents(archive)).get("planned-workouts.csv");

    expect(csv).toContain("intervals.icu");
    expect(csv).toContain("own-session");
    expect(csv).toContain("Owner Ramp");
    expect(csv).toContain('"{""steps"":[{""duration"":600}]}"');
    expect(csv).not.toContain("other-session");
    expect(csv).not.toContain("Other Ramp");
    expect(csv).not.toContain('"{""steps"":[{""duration"":300}]}"');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await context.cleanup();
  }
}, 120000);

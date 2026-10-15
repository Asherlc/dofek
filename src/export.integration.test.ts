import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import yauzl from "yauzl";
import { seedOwnedClimbingGraph } from "./db/climbing-lifecycle-test-helpers.ts";
import { setupTestDatabase } from "./db/test-helpers.ts";
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

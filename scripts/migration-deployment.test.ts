import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseMigrationDeployment } from "./migration-deployment.ts";

const entries = [
  { idx: 0, when: 1000, tag: "0000_baseline" },
  { idx: 7, when: 1001, tag: "0001_next" },
  { idx: 1, when: 1002, tag: "0002_latest" },
];
const journal = (history = entries) => ({ version: "7", dialect: "postgresql", entries: history });
const maintenanceMarker = "-- dofek: deployment-mode=maintenance";

describe("chooseMigrationDeployment", () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "dofek-deployment-migrations-"));
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal()));
    for (const entry of entries) await writeFile(join(folder, `${entry.tag}.sql`), "SELECT 1;\n");
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("chooses maintenance for the first release without a deployed image journal", async () => {
    await expect(chooseMigrationDeployment(folder, null, null)).resolves.toEqual({
      mode: "maintenance",
      tags: ["0000_baseline", "0001_next", "0002_latest"],
      targetMigrationTag: "0002_latest",
    });
  });

  it("keeps ordinary appended migrations in their canonical journal order", async () => {
    await expect(
      chooseMigrationDeployment(folder, journal(entries.slice(0, 1)), null),
    ).resolves.toEqual({
      mode: "rolling",
      tags: ["0001_next", "0002_latest"],
      targetMigrationTag: "0002_latest",
    });
  });

  it("preserves historical reused indices while comparing entries by journal position", async () => {
    const reusedIndices = entries.map((entry) => ({ ...entry, idx: 0 }));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal(reusedIndices)));
    await expect(
      chooseMigrationDeployment(folder, journal(reusedIndices.slice(0, 1)), null),
    ).resolves.toEqual({
      mode: "rolling",
      tags: ["0001_next", "0002_latest"],
      targetMigrationTag: "0002_latest",
    });
  });

  it("keeps a marked migration in maintenance until the deployed release includes it", async () => {
    await writeFile(join(folder, "0001_next.sql"), `${maintenanceMarker}\nSELECT 1;\n`);
    const deployedJournal = journal(entries.slice(0, 1));
    await expect(chooseMigrationDeployment(folder, deployedJournal, null)).resolves.toEqual({
      mode: "maintenance",
      tags: ["0001_next", "0002_latest"],
      targetMigrationTag: "0002_latest",
    });
    await expect(chooseMigrationDeployment(folder, journal(), null)).resolves.toEqual({
      mode: "rolling",
      tags: [],
      targetMigrationTag: "0002_latest",
    });
  });

  it("rolls an upgrade when a maintenance marker belongs to already deployed history", async () => {
    await writeFile(join(folder, "0000_baseline.sql"), `${maintenanceMarker}\nSELECT 1;\n`);
    await expect(
      chooseMigrationDeployment(folder, journal(entries.slice(0, 2)), null),
    ).resolves.toEqual({
      mode: "rolling",
      tags: ["0002_latest"],
      targetMigrationTag: "0002_latest",
    });
  });

  it("accepts CRLF line endings for the exact first-line maintenance marker", async () => {
    await writeFile(join(folder, "0002_latest.sql"), `${maintenanceMarker}\r\nSELECT 1;\r\n`);
    await expect(
      chooseMigrationDeployment(folder, journal(entries.slice(0, 2)), null),
    ).resolves.toEqual({
      mode: "maintenance",
      tags: ["0002_latest"],
      targetMigrationTag: "0002_latest",
    });
  });

  it.each([
    { idx: 4, when: 1000, tag: "0000_baseline" },
    { idx: 0, when: 999, tag: "0000_baseline" },
    { idx: 0, when: 1000, tag: "0000_different" },
  ])("rejects divergent deployed entry %j", async (entry) => {
    await expect(chooseMigrationDeployment(folder, journal([entry]), null)).rejects.toThrow(
      /prefix/i,
    );
  });

  it("rejects reordering deployed history even when every entry is known", async () => {
    const first = entries[0];
    const second = entries[1];
    if (!first || !second) throw new Error("Expected ordered history fixtures");
    await expect(
      chooseMigrationDeployment(folder, journal([second, first]), null),
    ).rejects.toThrow();
  });

  it("rejects rolling back to a shorter target journal", async () => {
    await writeFile(
      join(folder, "meta/_journal.json"),
      JSON.stringify(journal(entries.slice(0, 2))),
    );
    await expect(chooseMigrationDeployment(folder, journal(), null)).rejects.toThrow(/rollback/i);
  });

  it.each([
    {},
    { entries: "invalid" },
    { entries: [{ idx: "0", when: 1000, tag: "0000_baseline" }] },
    { entries: [{ idx: 0, when: 1.5, tag: "0000_baseline" }] },
    { entries: [{ idx: 0, when: 1000, tag: "../outside" }] },
    { entries: [entries[0], entries[0]] },
  ])("rejects malformed deployed journal %j", async (deployed) => {
    await expect(chooseMigrationDeployment(folder, deployed, null)).rejects.toThrow();
  });

  it("rejects malformed target journal data", async () => {
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ entries: [{}] }));
    await expect(chooseMigrationDeployment(folder, null, null)).rejects.toThrow();
  });

  it("fails when a registered target migration SQL file is missing", async () => {
    await unlink(join(folder, "0002_latest.sql"));
    await expect(chooseMigrationDeployment(folder, journal(), null)).rejects.toThrow(
      /0002_latest.sql/,
    );
  });

  it.each([
    "-- dofek: deployment-mode=rolling\nSELECT 1;",
    "-- dofek: deployment-mode=offline\nSELECT 1;",
    "-- dofek: deployment-mode=\nSELECT 1;",
    "-- DOFEK: deployment-mode=maintenance\nSELECT 1;",
    "-- dofek: Deployment-Mode=maintenance\nSELECT 1;",
    " -- dofek: deployment-mode=maintenance\nSELECT 1;",
    `${maintenanceMarker} \nSELECT 1;`,
    `-- Another comment\n${maintenanceMarker}\nSELECT 1;`,
  ])("rejects an unsupported or misplaced deployment directive %j", async (sql) => {
    await writeFile(join(folder, "0002_latest.sql"), sql);
    await expect(
      chooseMigrationDeployment(folder, journal(entries.slice(0, 2)), null),
    ).rejects.toThrow(/deployment-mode/i);
  });

  it("ignores deployment-marker text inside a SQL string", async () => {
    await writeFile(join(folder, "0002_latest.sql"), `SELECT '${maintenanceMarker}';\n`);
    await expect(
      chooseMigrationDeployment(folder, journal(entries.slice(0, 2)), null),
    ).resolves.toEqual({
      mode: "rolling",
      tags: ["0002_latest"],
      targetMigrationTag: "0002_latest",
    });
  });

  it("rejects a fenced old target after a newer schema migration has committed", async () => {
    const oldJournal = journal(entries.slice(0, 2));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(oldJournal));
    await expect(chooseMigrationDeployment(folder, oldJournal, "0002_latest")).rejects.toThrow(
      /maintenance boundary.*0002_latest/i,
    );
  });

  it("keeps a compatible retry in maintenance while its durable fence remains", async () => {
    await expect(chooseMigrationDeployment(folder, journal(), "0002_latest")).resolves.toEqual({
      mode: "maintenance",
      tags: [],
      targetMigrationTag: "0002_latest",
    });
  });

  it("accepts a later compatible release while preserving maintenance mode", async () => {
    await expect(
      chooseMigrationDeployment(folder, journal(entries.slice(0, 2)), "0001_next"),
    ).resolves.toEqual({
      mode: "maintenance",
      tags: ["0002_latest"],
      targetMigrationTag: "0002_latest",
    });
  });

  it("still rejects divergent deployed history when the target contains the fence", async () => {
    await expect(
      chooseMigrationDeployment(
        folder,
        journal([{ idx: 0, when: 1000, tag: "0000_other" }]),
        "0002_latest",
      ),
    ).rejects.toThrow(/prefix/i);
  });

  it("requires a nonempty target journal before publishing its fence tag", async () => {
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal([])));
    await expect(chooseMigrationDeployment(folder, null, null)).rejects.toThrow(/nonempty/i);
  });
});

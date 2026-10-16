import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withMigrationPrefix } from "./migration-prefix.ts";

it("copies only registered prefix files while preserving journal timestamps and historical evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-prefix-test-"));
  try {
    await mkdir(join(root, "meta"));
    await mkdir(join(root, "_history"));
    const journal = {
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0, when: 123, tag: "0000_baseline", breakpoints: true, version: "7" },
        { idx: 1, when: 456, tag: "0001_prepare", breakpoints: true, version: "7" },
        { idx: 2, when: 789, tag: "0002_finalize", breakpoints: true, version: "7" },
      ],
    };
    await writeFile(join(root, "meta/_journal.json"), JSON.stringify(journal));
    for (const e of journal.entries) await writeFile(join(root, `${e.tag}.sql`), e.tag);
    await writeFile(join(root, "_history/old.sql"), "immutable old evidence");
    await withMigrationPrefix(root, 1, async (prefix) => {
      expect(JSON.parse(await readFile(join(prefix, "meta/_journal.json"), "utf8"))).toEqual({
        ...journal,
        entries: journal.entries.slice(0, 2),
      });
      expect(await readFile(join(prefix, "0001_prepare.sql"), "utf8")).toBe("0001_prepare");
      expect(await readFile(join(prefix, "_history/old.sql"), "utf8")).toBe(
        "immutable old evidence",
      );
    });
    await expect(withMigrationPrefix(root, 3, async () => {})).rejects.toThrow("not registered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** Keep the repository's immutable history while restricting the migration boundary. */
export async function withMigrationPrefix<T>(
  directory: string,
  throughIndex: number,
  operation: (prefix: string) => Promise<T>,
): Promise<T> {
  const journal = z
    .object({
      entries: z.array(
        z.object({ idx: z.number().int(), tag: z.string(), when: z.number() }).passthrough(),
      ),
    })
    .passthrough()
    .parse(JSON.parse(await readFile(join(directory, "meta/_journal.json"), "utf8")));
  if (!journal.entries.some((entry) => entry.idx === throughIndex))
    throw new Error("Migration prefix boundary is not registered.");
  const prefix = await mkdtemp(join(tmpdir(), "dofek-migration-prefix-"));
  try {
    const entries = journal.entries.filter((entry) => entry.idx <= throughIndex);
    await mkdir(join(prefix, "meta"));
    await writeFile(
      join(prefix, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries }, null, 2),
    );
    for (const entry of entries)
      await cp(join(directory, `${entry.tag}.sql`), join(prefix, `${entry.tag}.sql`));
    await cp(join(directory, "_history"), join(prefix, "_history"), { recursive: true });
    return await operation(prefix);
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
}

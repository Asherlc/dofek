import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const journalSchema = z
  .object({
    entries: z.array(
      z.object({
        idx: z.number().int().nonnegative(),
        when: z.number().int().nonnegative(),
        tag: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      }),
    ),
  })
  .superRefine(({ entries }, context) => {
    const tags = new Set<string>();
    for (const [position, entry] of entries.entries()) {
      const previous = entries[position - 1];
      if (tags.has(entry.tag) || (previous && previous.when >= entry.when)) {
        context.addIssue({
          code: "custom",
          path: ["entries", position],
          message: "Migration journal entries require unique tags and increasing timestamps.",
        });
      }
      tags.add(entry.tag);
    }
  });

const maintenanceMarker = "-- dofek: deployment-mode=maintenance";

export async function chooseMigrationDeployment(
  targetFolder: string,
  deployedJournal: unknown | null,
  maintenanceBoundary: string | null,
): Promise<{ mode: "rolling" | "maintenance"; tags: string[]; targetMigrationTag: string }> {
  const target = journalSchema.parse(
    JSON.parse(await readFile(join(targetFolder, "meta/_journal.json"), "utf8")),
  );
  const latestMigration = target.entries.at(-1);
  if (!latestMigration) throw new Error("Target migration journal must be nonempty.");
  if (
    maintenanceBoundary !== null &&
    !target.entries.some((entry) => entry.tag === maintenanceBoundary)
  ) {
    throw new Error(
      `Target journal is missing required maintenance boundary ${maintenanceBoundary}.`,
    );
  }
  const deployed = deployedJournal === null ? null : journalSchema.parse(deployedJournal);
  const deployedCount = deployed?.entries.length ?? 0;
  if (deployedCount > target.entries.length) {
    throw new Error("Migration deployment rollback is unsupported: target history is shorter.");
  }
  for (const [position, entry] of (deployed?.entries ?? []).entries()) {
    const expected = target.entries[position];
    if (
      !expected ||
      entry.idx !== expected.idx ||
      entry.tag !== expected.tag ||
      entry.when !== expected.when
    ) {
      throw new Error("Deployed migration journal must be an exact prefix of target history.");
    }
  }
  const maintenance = await Promise.all(
    target.entries.map(async (entry) => {
      const path = join(targetFolder, `${entry.tag}.sql`);
      const lines = (await readFile(path, "utf8")).split(/\r?\n/);
      for (const [position, line] of lines.entries()) {
        if (
          /^\s*--\s*dofek:\s*deployment-mode\b/i.test(line) &&
          (position !== 0 || line !== maintenanceMarker)
        ) {
          throw new Error(`Unsupported deployment-mode directive in ${path}:${position + 1}.`);
        }
      }
      return lines[0] === maintenanceMarker;
    }),
  );
  const tags = target.entries.slice(deployedCount).map((entry) => entry.tag);
  return {
    mode:
      maintenanceBoundary !== null ||
      deployed === null ||
      maintenance.slice(deployedCount).some(Boolean)
        ? "maintenance"
        : "rolling",
    tags,
    targetMigrationTag: latestMigration.tag,
  };
}

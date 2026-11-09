import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { captureException } from "../lib/error-reporting.ts";
import { parseDbtRunArtifacts } from "../processing/dbt-run-results.ts";
import type { AnalyticsQueryOwner } from "./analytics-query-owner.ts";

/** Keep the registered child non-terminal until its fresh build artifacts agree. */
export async function runOwnedDbtBuild(
  owner: Pick<AnalyticsQueryOwner, "runSynchronousDbt">,
  artifactDirectory: string,
  selectedModels: readonly string[] | "all",
  run: () => Promise<number>,
): Promise<number> {
  let exitCode: number | undefined;
  try {
    return await owner.runSynchronousDbt(async () => {
      await Promise.all(
        ["manifest.json", "run_results.json"].map((name) =>
          rm(join(artifactDirectory, name), { force: true }),
        ),
      );
      exitCode = await run();
      if (exitCode !== 0) return exitCode;
      const [manifest, runResults] = await Promise.all(
        ["manifest.json", "run_results.json"].map(
          async (name): Promise<unknown> =>
            JSON.parse(await readFile(join(artifactDirectory, name), "utf8")),
        ),
      );
      const result = parseDbtRunArtifacts({
        manifest,
        runResults,
        selectedModels,
        sources: {
          metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/sources/v3.json" },
          results: [],
        },
      });
      if (!result.succeeded) throw new Error("dbt child produced incomplete build artifacts");
      return exitCode;
    });
  } catch (error) {
    captureException(error, { tags: { source: "owned-dbt-build" } });
    // Preserve existing processing failure reporting. The owner's durable child
    // admission remains non-terminal; a known nonzero exit is never success.
    if (exitCode !== undefined && exitCode !== 0) return exitCode;
    throw error;
  }
}

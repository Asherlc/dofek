import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { analyticsPageVarsSchema } from "./analytics-page-scope.ts";

const models = { scalar: "sensor_scalar_sample", dedup: "deduped_sensor" } as const;
const manifestSchema = z.object({
  metadata: z.object({ invocation_id: z.string().min(1) }),
  nodes: z.record(z.string(), z.unknown()),
});

/** Native compilation only. The caller must capture an authorized page before deriving vars. */
export async function compileAnalyticsPageSql(input: {
  stage: "scalar" | "dedup";
  vars: z.infer<typeof analyticsPageVarsSchema>;
  artifactDirectory: string;
}): Promise<{ sql: string; relation: string; nodeId: string; artifactDirectory: string }> {
  const stage = z.enum(["scalar", "dedup"]).parse(input.stage);
  const vars = analyticsPageVarsSchema.parse(input.vars);
  const model = models[stage];
  const nodeId = `model.dofek_analytics.${model}`;
  // Every invocation owns a fresh directory: a missing new manifest cannot reuse old SQL.
  const artifactDirectory = await mkdtemp(join(resolve(input.artifactDirectory), "compile-"));
  const args = [
    "--no-populate-cache",
    "--no-partial-parse",
    "compile",
    "--no-introspect",
    "--project-dir",
    "analytics",
    "--profiles-dir",
    "analytics",
    "--threads",
    "1",
    "--target-path",
    artifactDirectory,
    "--log-path",
    join(artifactDirectory, "logs"),
    "--select",
    model,
    "--vars",
    JSON.stringify(vars),
  ];
  await new Promise<void>((resolveProcess, reject) => {
    const child = spawn("dbt", args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolveProcess();
      else
        reject(
          new Error(
            `dbt compile failed (${code ?? signal ?? "unknown exit"}); artifacts: ${artifactDirectory}`,
          ),
        );
    });
  });
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(artifactDirectory, "manifest.json"), "utf8")),
  );
  const node = z
    .object({
      unique_id: z.literal(nodeId),
      resource_type: z.literal("model"),
      package_name: z.literal("dofek_analytics"),
      name: z.literal(model),
      alias: z.literal(model),
      schema: z.string().min(1),
      relation_name: z.string().trim().min(1),
      compiled_code: z.string().trim().min(1),
      config: z.object({
        materialized: z.literal("incremental"),
        incremental_strategy: z.literal("append"),
      }),
    })
    .safeParse(manifest.nodes[nodeId]);
  if (!node.success)
    throw new Error(`Invalid compiled model manifest ${nodeId}: ${node.error.message}`);
  return {
    sql: node.data.compiled_code,
    relation: node.data.relation_name,
    nodeId,
    artifactDirectory,
  };
}

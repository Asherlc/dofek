import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

/** Real dbt project resources with private vars, including payloads too large for argv. */
export async function withActivityScopeDbtProject<T>(
  variables: Record<string, unknown>,
  run: (project: string) => Promise<T>,
): Promise<T> {
  const project = await mkdtemp(join(tmpdir(), "activity-scope-dbt-test-"));
  try {
    const config = z
      .record(z.string(), z.unknown())
      .parse(parse(await readFile("analytics/dbt_project.yml", "utf8")));
    for (const [key, fallback] of Object.entries({
      "model-paths": "models",
      "macro-paths": "macros",
      "test-paths": "tests",
      "analysis-paths": "analyses",
      "seed-paths": "seeds",
      "snapshot-paths": "snapshots",
    })) {
      const paths = z.array(z.string()).parse(config[key] ?? [fallback]);
      config[key] = await Promise.all(
        paths.map(async (path, index) => {
          const name = `${fallback}-${index}`;
          await symlink(resolve("analytics", path), join(project, name), "dir");
          return name;
        }),
      );
    }
    await mkdir(join(project, "scope-test-models"));
    config["model-paths"] = [
      ...z.array(z.string()).parse(config["model-paths"]),
      "scope-test-models",
    ];
    config.vars = { ...z.record(z.string(), z.unknown()).parse(config.vars ?? {}), ...variables };
    await writeFile(
      join(project, "dbt_project.yml"),
      stringify(config, { defaultStringType: "QUOTE_DOUBLE" }),
      { mode: 0o600 },
    );
    return await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

/** Read this invocation's compiled SELECTs, including dbt's separate daily batch nodes. */
export async function readDbtCompiledQueries(target: string, models: readonly string[]) {
  const metadata = z.object({ invocation_id: z.uuid() });
  const manifest = z
    .object({ metadata, nodes: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(await readFile(join(target, "manifest.json"), "utf8")));
  const batch = z.tuple([z.iso.datetime({ offset: true }), z.iso.datetime({ offset: true })]);
  const results = z
    .object({
      metadata,
      results: z.array(
        z.object({
          unique_id: z.string(),
          status: z.string(),
          batch_results: z
            .object({ successful: z.array(batch), failed: z.array(batch) })
            .nullable(),
        }),
      ),
    })
    .parse(JSON.parse(await readFile(join(target, "run_results.json"), "utf8")));
  if (manifest.metadata.invocation_id !== results.metadata.invocation_id) {
    throw new Error("Compiled artifact invocation mismatch");
  }
  const queries = [];
  for (const model of models) {
    const uniqueId = `model.dofek_analytics.${model}`;
    const parsedNode = z
      .object({
        unique_id: z.literal(uniqueId),
        name: z.literal(model),
        resource_type: z.literal("model"),
        package_name: z.literal("dofek_analytics"),
        path: z.literal(`read_models/${model}.sql`),
        original_file_path: z.literal(`models-0/read_models/${model}.sql`),
        config: z.object({
          incremental_strategy: z.string(),
          batch_size: z.string().nullable(),
          query_settings: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional(),
        }),
      })
      .safeParse(manifest.nodes[uniqueId]);
    if (!parsedNode.success) throw new Error(`Invalid compiled model identity/config: ${model}`);
    const node = parsedNode.data;
    const matches = results.results.filter((result) => result.unique_id === uniqueId);
    const result = matches[0];
    if (matches.length !== 1 || result?.status !== "success") {
      throw new Error(`Expected one successful result for ${model}`);
    }
    const normalPath = join("compiled", node.package_name, node.original_file_path);
    let variants: { batch: string | null; path: string }[];
    if (node.config.incremental_strategy === "microbatch") {
      const batches = result.batch_results;
      if (
        node.config.batch_size !== "day" ||
        !batches ||
        batches.failed.length > 0 ||
        batches.successful.length === 0
      ) {
        throw new Error(`Invalid daily batch results for ${model}`);
      }
      // dbt 1.11.12 MicrobatchBatchRunner.compile passes format_batch_start
      // to ParsedNode.get_target_write_path; daily suffixes are YYYY-MM-DD.
      const days = batches.successful.map(([start]) => start.slice(0, 10));
      if (new Set(days).size !== days.length) {
        throw new Error(`Duplicate daily batch results for ${model}`);
      }
      const directory = join(dirname(normalPath), model);
      variants = days.sort().map((day) => ({
        batch: day,
        path: join(directory, `${model}_${day}.sql`),
      }));
      const files = (await readdir(join(target, directory))).sort();
      if (JSON.stringify(files) !== JSON.stringify(variants.map(({ path }) => basename(path)))) {
        throw new Error(`Unexpected batch artifact inventory for ${model}`);
      }
    } else {
      if (result.batch_results !== null) {
        throw new Error(`Unexpected batch results for ${model}`);
      }
      variants = [{ batch: null, path: normalPath }];
    }
    for (const variant of variants) {
      const sql = await readFile(join(target, variant.path), "utf8");
      if (!sql.trim()) throw new Error(`Empty compiled SQL for ${model}`);
      queries.push({ model, ...variant, sql, settings: node.config.query_settings });
    }
  }
  return queries;
}

/** Pinned dbt-clickhouse execute/add_query log the final commented SQL verbatim. */
export function readDbtStatementMessages(log: string): string[] {
  return log
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      const event = z.object({ info: z.object({ msg: z.string() }) }).parse(JSON.parse(line));
      const match = event.info.msg.match(/^dbt_clickhouse adapter: On [^\n]+?: ([\s\S]*)\.\.\.$/);
      return match?.[1] ? [match[1]] : [];
    });
}

/** Match only the statement's operation/target, never a downstream dependency. */
export function readDbtStatementTarget(query: string) {
  const statement = query.replace(/^(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$))*/, "");
  const match = statement.match(
    /^(create\s+table|insert\s+into)\s+("[^"]+"|`[^`]+`|\w+)\s*\.\s*("[^"]+"|`[^`]+`|\w+)(?=\s|\()/i,
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    operation: match[1].toLowerCase().startsWith("create") ? "create" : "insert",
    database: match[2].replace(/^["`]|["`]$/g, ""),
    model: match[3].replace(/^["`]|["`]$/g, ""),
  };
}

/** Sanitize every displayed stream before bounding it, retaining first fatal events. */
export function dbtFailureDiagnostic(
  result: { stdout: string; stderr: string },
  payload: string,
): string {
  const sanitize = (value: string) => {
    let sanitized = value;
    if (payload.length > 0) {
      sanitized = sanitized
        .replaceAll(payload, "<packed UUID scope>")
        .replaceAll(JSON.stringify(payload).slice(1, -1), "<packed UUID scope>");
    }
    // Parser errors can quote only a fragment of the packed literal.
    return sanitized.replace(/[A-Za-z0-9+/]{64,}={0,2}/g, "<packed UUID scope>");
  };
  const failures = sanitize(result.stdout)
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      const event = z
        .object({ info: z.object({ level: z.string(), msg: z.string() }) })
        .parse(JSON.parse(line));
      return event.info.level === "error" ? [event.info.msg.slice(0, 1200)] : [];
    })
    .slice(0, 3);
  return JSON.stringify({ failures, stderr: sanitize(result.stderr).slice(0, 1200) }).slice(
    0,
    5000,
  );
}

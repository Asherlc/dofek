import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

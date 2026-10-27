import { z } from "zod";

const manifestNodeSchema = z.object({
  unique_id: z.string().min(1),
  name: z.string().min(1),
  resource_type: z.string().min(1).optional(),
});
const manifestSchema = z.object({
  metadata: z.object({ dbt_schema_version: z.string().url() }).passthrough(),
  nodes: z.record(z.string(), manifestNodeSchema),
});
const runResultSchema = z.object({
  unique_id: z.string().min(1),
  status: z.enum([
    "success",
    "pass",
    "warn",
    "error",
    "fail",
    "skipped",
    "partial success",
    "runtime error",
    "no-op",
  ]),
  execution_time: z.number().nonnegative(),
  message: z.string().nullable(),
});
const runResultsSchema = z.object({
  metadata: z.object({ invocation_id: z.string().min(1) }).passthrough(),
  results: z.array(runResultSchema),
});
const sourceResultSchema = z.object({
  unique_id: z.string().min(1),
  max_loaded_at: z.string().datetime({ offset: true }).nullable(),
  status: z.string().min(1),
});
const sourcesSchema = z.object({
  metadata: z.object({ dbt_schema_version: z.string().url() }).passthrough(),
  results: z.array(sourceResultSchema),
});

export interface DbtModelResult {
  name: string;
  uniqueId: string;
  status: "succeeded" | "failed" | "skipped";
  warning: boolean;
  executionTimeSeconds: number;
  errorCode: string | null;
  message: string | null;
}

export interface ParsedDbtRunArtifacts {
  invocationId: string;
  succeeded: boolean;
  models: DbtModelResult[];
  sourceWatermarks: Record<string, string>;
}

interface ParseDbtRunArtifactsInput {
  manifest: unknown;
  runResults: unknown;
  sources: unknown;
  selectedModels: readonly string[];
}

function sanitizedMessage(message: string | null): string | null {
  if (!message) return null;
  return message.replaceAll(/\s+/g, " ").trim().slice(0, 500) || null;
}

export function parseDbtRunArtifacts({
  manifest,
  runResults,
  sources,
  selectedModels,
}: ParseDbtRunArtifactsInput): ParsedDbtRunArtifacts {
  const parsedManifest = manifestSchema.parse(manifest);
  const parsedRunResults = runResultsSchema.parse(runResults);
  const parsedSources = sourcesSchema.parse(sources);
  const manifestNodeByUniqueId = new Map(
    Object.values(parsedManifest.nodes).map((node) => [node.unique_id, node]),
  );
  const selectedModelSet = new Set(selectedModels);
  const resultByModelName = new Map<string, z.infer<typeof runResultSchema>>();

  for (const result of parsedRunResults.results) {
    const node = manifestNodeByUniqueId.get(result.unique_id);
    if (!node) {
      if (result.unique_id.startsWith("model.")) {
        throw new Error(`dbt result ${result.unique_id} is missing from manifest`);
      }
      continue;
    }
    if (
      (node.resource_type === undefined || node.resource_type === "model") &&
      selectedModelSet.has(node.name)
    ) {
      resultByModelName.set(node.name, result);
    }
  }

  const models = selectedModels.map((name): DbtModelResult => {
    const manifestNode = Object.values(parsedManifest.nodes).find(
      (node) =>
        node.name === name && (node.resource_type === undefined || node.resource_type === "model"),
    );
    if (!manifestNode) throw new Error(`Selected dbt model ${name} is missing from manifest`);
    const result = resultByModelName.get(name);
    if (!result) {
      return {
        name,
        uniqueId: manifestNode.unique_id,
        status: "failed",
        warning: false,
        executionTimeSeconds: 0,
        errorCode: "selected_model_unattempted",
        message: "The selected analytics model was not attempted.",
      };
    }
    const failed =
      result.status === "error" ||
      result.status === "fail" ||
      result.status === "partial success" ||
      result.status === "runtime error";
    return {
      name,
      uniqueId: result.unique_id,
      status: failed ? "failed" : result.status === "skipped" ? "skipped" : "succeeded",
      warning: result.status === "warn",
      executionTimeSeconds: result.execution_time,
      errorCode: failed ? "dbt_model_failed" : null,
      message: sanitizedMessage(result.message),
    };
  });

  const sourceWatermarks = Object.fromEntries(
    parsedSources.results.flatMap((source) =>
      source.max_loaded_at ? [[source.unique_id, source.max_loaded_at]] : [],
    ),
  );
  return {
    invocationId: parsedRunResults.metadata.invocation_id,
    succeeded: models.every((model) => model.status === "succeeded"),
    models,
    sourceWatermarks,
  };
}

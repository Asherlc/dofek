import { ActivitySearchIndex } from "./opensearch.ts";

export function createActivitySearchIndexFromEnv(
  credential: "ACTIVITY_SEARCH_READ_URL" | "ACTIVITY_SEARCH_WRITE_URL",
  environment: NodeJS.ProcessEnv = process.env,
): ActivitySearchIndex | undefined {
  const enabled = environment.ACTIVITY_SEARCH_ENABLED;
  if (enabled === undefined || enabled === "false") return undefined;
  if (enabled !== "true") {
    throw new Error("ACTIVITY_SEARCH_ENABLED must be true or false.");
  }
  const uri = environment[credential];
  if (!uri) throw new Error(`${credential} is required when activity search is enabled.`);
  return new ActivitySearchIndex(uri);
}

export function createActivitySearchErasureIndexFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): ActivitySearchIndex | undefined {
  const uri = environment.ACTIVITY_SEARCH_ERASE_URL;
  if (uri) return new ActivitySearchIndex(uri);
  if (
    environment.ACTIVITY_SEARCH_ENABLED === "true" ||
    environment.ACTIVITY_SEARCH_RETENTION_TOKEN
  ) {
    throw new Error("ACTIVITY_SEARCH_ERASE_URL is required for activity search erasure.");
  }
  return undefined;
}

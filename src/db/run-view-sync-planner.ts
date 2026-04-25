import { planMaterializedViewSync } from "./view-sync-planner.ts";

export async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const plan = await planMaterializedViewSync(databaseUrl);
  process.stdout.write(`required=${plan.required ? "true" : "false"}\n`);
  process.stdout.write(`reasons=${plan.reasons.join(",")}\n`);
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}

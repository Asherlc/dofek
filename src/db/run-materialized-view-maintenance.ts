import { Client } from "pg";
import {
  MATERIALIZED_VIEW_REFRESH_INVENTORY,
  rebuildMaterializedViewForMaintenance,
  refreshMaterializedViewForMaintenance,
  runQuietDatabasePreflight,
} from "./materialized-view-maintenance.ts";
import { syncMaterializedViews } from "./sync-views.ts";

function usage(): string {
  return [
    "Usage: pnpm tsx src/db/run-materialized-view-maintenance.ts <command>",
    "",
    "Commands:",
    "  inventory             Print materialized views that qualify for concurrent refresh",
    "  preflight             Check whether the database is quiet enough for maintenance",
    "  refresh <view-name>   Run a monitored concurrent refresh and wait for completion",
    "  rebuild <view-name>   Drop and recreate one canonical materialized view",
    "  sync                  Run materialized-view sync and wait for completion",
  ].join("\n");
}

function databaseUrlFromEnv(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return databaseUrl;
}

function printInventory(): void {
  for (const item of MATERIALIZED_VIEW_REFRESH_INVENTORY) {
    process.stdout.write(
      `${item.viewName}\t${item.refreshRisk}\t${item.concurrentRefreshIndex}\t${item.notes}\n`,
    );
  }
}

export async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "inventory") {
    printInventory();
    return;
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const databaseUrl = databaseUrlFromEnv();
  const client = new Client({ connectionString: databaseUrl });
  let clientClosed = false;

  try {
    await client.connect();

    if (command === "preflight") {
      const result = await runQuietDatabasePreflight(client);
      for (const warning of result.warnings) {
        process.stdout.write(`warning=${warning}\n`);
      }
      if (!result.ok) {
        throw new Error(`quiet database preflight failed: ${result.failures.join("; ")}`);
      }
      process.stdout.write("ok=true\n");
      return;
    }

    if (command === "refresh") {
      const viewName = process.argv[3];
      if (!viewName) {
        throw new Error("refresh requires a view name");
      }
      process.stdout.write(`refreshing=${viewName}\n`);
      const result = await refreshMaterializedViewForMaintenance(client, viewName);
      for (const warning of result.warnings) {
        process.stdout.write(`warning=${warning}\n`);
      }
      process.stdout.write(
        `refreshed=${result.viewName} mode=${result.mode} duration_ms=${result.durationMs}\n`,
      );
      return;
    }

    if (command === "rebuild") {
      const viewName = process.argv[3];
      if (!viewName) {
        throw new Error("rebuild requires a view name");
      }
      process.stdout.write(`rebuilding=${viewName}\n`);
      const result = await rebuildMaterializedViewForMaintenance(client, viewName);
      for (const warning of result.warnings) {
        process.stdout.write(`warning=${warning}\n`);
      }
      process.stdout.write(
        `rebuilt=${result.viewName} mode=${result.mode} duration_ms=${result.durationMs}\n`,
      );
      return;
    }

    if (command === "sync") {
      const preflight = await runQuietDatabasePreflight(client);
      for (const warning of preflight.warnings) {
        process.stdout.write(`warning=${warning}\n`);
      }
      if (!preflight.ok) {
        throw new Error(`quiet database preflight failed: ${preflight.failures.join("; ")}`);
      }
      await client.end();
      clientClosed = true;
      const result = await syncMaterializedViews(databaseUrl);
      process.stdout.write(
        `synced=${result.synced} skipped=${result.skipped} refreshed=${result.refreshed}\n`,
      );
      return;
    }

    throw new Error(`unknown command: ${command}\n${usage()}`);
  } finally {
    if (!clientClosed) {
      await client.end();
    }
  }
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

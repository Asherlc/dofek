import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";
import {
  computeViewDependencyFingerprintHash,
  ensureMaterializedViewTrackingTables,
  extractViewName,
  hashViewContent,
} from "./sync-views.ts";

type ViewHashRow = {
  hash: string;
  dependency_fingerprint_hash: string | null;
};

export type MaterializedViewSyncPlan = {
  required: boolean;
  reasons: string[];
};

type PlannerOptions = {
  viewsDir?: string;
};

async function findPendingRefreshMigrations(client: Pick<Client, "query">): Promise<Array<string>> {
  const result = await client.query<{ hash: string }>(`SELECT hash
    FROM drizzle.__drizzle_migrations
    WHERE requires_materialized_view_refresh = TRUE
      AND materialized_view_refresh_acknowledged_at IS NULL
    ORDER BY created_at ASC, id ASC`);
  return result.rows.map((row) => row.hash);
}

export async function planMaterializedViewSync(
  databaseUrl: string,
  options: PlannerOptions = {},
): Promise<MaterializedViewSyncPlan> {
  const dir = options.viewsDir ?? resolve(import.meta.dirname, "../../drizzle/_views");
  const files = readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await ensureMaterializedViewTrackingTables(client);

    const reasons: string[] = [];

    for (const fileName of files) {
      const content = readFileSync(join(dir, fileName), "utf-8");
      const viewName = extractViewName(content);
      if (!viewName) {
        continue;
      }

      const viewHash = hashViewContent(content);
      const existing = await client.query<ViewHashRow>(
        `SELECT hash, dependency_fingerprint_hash
         FROM drizzle.__view_hashes
         WHERE view_name = $1`,
        [viewName],
      );
      const stored = existing.rows[0];

      if (!stored || stored.hash !== viewHash) {
        reasons.push(`view_definition_changed:${viewName}:${viewHash}`);
        continue;
      }

      const currentFingerprintHash = await computeViewDependencyFingerprintHash(client, viewName);
      if (
        stored.dependency_fingerprint_hash &&
        stored.dependency_fingerprint_hash !== currentFingerprintHash
      ) {
        reasons.push(`dependency_fingerprint_changed:${viewName}`);
        continue;
      }

      if (!stored.dependency_fingerprint_hash) {
        await client.query(
          `UPDATE drizzle.__view_hashes
           SET dependency_fingerprint_hash = $1
           WHERE view_name = $2`,
          [currentFingerprintHash, viewName],
        );
      }
    }

    const pendingRefreshMigrations = await findPendingRefreshMigrations(client);
    for (const migrationHash of pendingRefreshMigrations) {
      reasons.push(`migration_requires_materialized_view_refresh:${migrationHash}`);
    }

    return {
      required: reasons.length > 0,
      reasons,
    };
  } finally {
    await client.end();
  }
}

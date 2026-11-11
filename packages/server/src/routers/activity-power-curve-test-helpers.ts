import type { ClickHouseClient } from "../../../../src/db/clickhouse.ts";
import { readModelSql, renderDbtModelSql } from "../../../../src/db/read-model-sql-test-helpers.ts";

/** Build the canonical curve model after a fixture has populated its sensor inputs. */
export async function rebuildTestActivityPowerCurve(client: ClickHouseClient): Promise<void> {
  await client.command({ query: "TRUNCATE TABLE analytics.activity_power_curve" });
  const selectSql = renderDbtModelSql(readModelSql("activity_power_curve.sql"), {
    isIncremental: false,
  }).replace(/\{\{\s*ref\('([^']+)'\)\s*\}\}/g, "analytics.$1");
  await client.command({
    query: `INSERT INTO analytics.activity_power_curve\n${selectSql}\nSETTINGS join_use_nulls = 1, max_threads = 1`,
  });
}

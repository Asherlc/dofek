import { describe, expect, it } from "vitest";
import { compactWhitespace, readModelSql } from "./read-model-sql-test-helpers.ts";

const modelSql = readModelSql("provider_change_watermark.sql");

describe("provider_change_watermark model", () => {
  it("materializes incremental watermarks from compact insert-time state", () => {
    const normalizedSql = compactWhitespace(modelSql);

    expect(modelSql).toContain("materialized='incremental'");
    expect(modelSql).toContain("incremental_strategy='append'");
    expect(modelSql).toContain("full_refresh=false");
    expect(modelSql).toContain("engine='ReplacingMergeTree(refresh_version)'");
    expect(modelSql).toContain("order_by='(user_id, provider_id)'");
    expect(modelSql).toContain("source('analytics', 'provider_change_state')");
    expect(modelSql).toContain("existing_provider_state AS");
    expect(normalizedSql).toContain(
      "source_provider_state.changed_at > existing_provider_state.changed_at",
    );
    expect(modelSql).not.toContain("source('postgres_fitness'");
    expect(modelSql).not.toContain("source('ingest'");
    expect(modelSql).toContain("'max_threads': 1");
    expect(modelSql).toContain("'join_use_nulls': 1");
  });
});

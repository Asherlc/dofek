import { describe, expect, it } from "vitest";
import { parseDbtRunArtifacts } from "./dbt-run-results.ts";

const manifest = {
  metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json" },
  nodes: {
    "model.dofek.daily_sleep": { unique_id: "model.dofek.daily_sleep", name: "daily_sleep" },
    "model.dofek.daily_recovery": {
      unique_id: "model.dofek.daily_recovery",
      name: "daily_recovery",
    },
  },
};

const sources = {
  metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/sources/v3.json" },
  results: [
    {
      unique_id: "source.dofek.postgres_fitness.sleep_session",
      max_loaded_at: "2026-07-22T11:59:00.000Z",
      status: "pass",
    },
  ],
};

describe("parseDbtRunArtifacts", () => {
  it("maps success, warning, skipped, and error results by manifest model name", () => {
    const parsed = parseDbtRunArtifacts({
      manifest,
      sources,
      selectedModels: ["daily_sleep", "daily_recovery"],
      runResults: {
        metadata: { invocation_id: "run-1" },
        results: [
          {
            unique_id: "model.dofek.daily_sleep",
            status: "success",
            execution_time: 1.25,
            message: null,
          },
          {
            unique_id: "model.dofek.daily_recovery",
            status: "warn",
            execution_time: 0.5,
            message: "Recovered with a warning",
          },
        ],
      },
    });

    expect(parsed.invocationId).toBe("run-1");
    expect(parsed.succeeded).toBe(true);
    expect(parsed.models).toEqual([
      {
        name: "daily_sleep",
        uniqueId: "model.dofek.daily_sleep",
        status: "succeeded",
        warning: false,
        executionTimeSeconds: 1.25,
        errorCode: null,
        message: null,
      },
      {
        name: "daily_recovery",
        uniqueId: "model.dofek.daily_recovery",
        status: "succeeded",
        warning: true,
        executionTimeSeconds: 0.5,
        errorCode: null,
        message: "Recovered with a warning",
      },
    ]);
    expect(parsed.sourceWatermarks).toEqual({
      "source.dofek.postgres_fitness.sleep_session": "2026-07-22T11:59:00.000Z",
    });
  });

  it("marks selected but unattempted models as failed", () => {
    const parsed = parseDbtRunArtifacts({
      manifest,
      sources,
      selectedModels: ["daily_sleep", "daily_recovery"],
      runResults: {
        metadata: { invocation_id: "run-2" },
        results: [
          {
            unique_id: "model.dofek.daily_sleep",
            status: "success",
            execution_time: 0,
            message: null,
          },
        ],
      },
    });

    expect(parsed.models).toEqual([
      {
        name: "daily_sleep",
        uniqueId: "model.dofek.daily_sleep",
        status: "succeeded",
        warning: false,
        executionTimeSeconds: 0,
        errorCode: null,
        message: null,
      },
      {
        name: "daily_recovery",
        uniqueId: "model.dofek.daily_recovery",
        status: "failed",
        warning: false,
        executionTimeSeconds: 0,
        errorCode: "selected_model_unattempted",
        message: "The selected analytics model was not attempted.",
      },
    ]);
    expect(parsed.succeeded).toBe(false);
  });

  it("preserves an explicitly skipped model result", () => {
    const parsed = parseDbtRunArtifacts({
      manifest,
      sources,
      selectedModels: ["daily_sleep"],
      runResults: {
        metadata: { invocation_id: "run-skipped" },
        results: [
          {
            unique_id: "model.dofek.daily_sleep",
            status: "skipped",
            execution_time: 0,
            message: "upstream skipped",
          },
        ],
      },
    });

    expect(parsed.models[0]).toEqual({
      name: "daily_sleep",
      uniqueId: "model.dofek.daily_sleep",
      status: "skipped",
      warning: false,
      executionTimeSeconds: 0,
      errorCode: null,
      message: "upstream skipped",
    });
    expect(parsed.succeeded).toBe(false);
  });

  it("maps failed results and sanitizes bounded artifact messages", () => {
    const longMessage = `  failure\n\t${"x".repeat(600)}  `;
    const parsed = parseDbtRunArtifacts({
      manifest,
      sources: {
        ...sources,
        results: [
          ...sources.results,
          {
            unique_id: "source.dofek.postgres_fitness.empty",
            max_loaded_at: null,
            status: "pass",
          },
        ],
      },
      selectedModels: ["daily_sleep", "daily_recovery"],
      runResults: {
        metadata: { invocation_id: "run-failed" },
        results: [
          {
            unique_id: "model.dofek.daily_sleep",
            status: "error",
            execution_time: 2,
            message: longMessage,
          },
          {
            unique_id: "model.dofek.daily_recovery",
            status: "fail",
            execution_time: 3,
            message: "   ",
          },
        ],
      },
    });

    expect(parsed.models).toEqual([
      {
        name: "daily_sleep",
        uniqueId: "model.dofek.daily_sleep",
        status: "failed",
        warning: false,
        executionTimeSeconds: 2,
        errorCode: "dbt_model_failed",
        message: `failure ${"x".repeat(492)}`,
      },
      {
        name: "daily_recovery",
        uniqueId: "model.dofek.daily_recovery",
        status: "failed",
        warning: false,
        executionTimeSeconds: 3,
        errorCode: "dbt_model_failed",
        message: null,
      },
    ]);
    expect(parsed.sourceWatermarks).toEqual({
      "source.dofek.postgres_fitness.sleep_session": "2026-07-22T11:59:00.000Z",
    });
    expect(parsed.succeeded).toBe(false);
  });

  it("maps every dbt run status emitted by the installed dbt version", () => {
    const extendedManifest = {
      ...manifest,
      nodes: {
        ...manifest.nodes,
        "model.dofek.activity_summary": {
          unique_id: "model.dofek.activity_summary",
          name: "activity_summary",
        },
      },
    };
    const parsed = parseDbtRunArtifacts({
      manifest: extendedManifest,
      sources,
      selectedModels: ["daily_sleep", "daily_recovery", "activity_summary"],
      runResults: {
        metadata: { invocation_id: "run-current-dbt-statuses" },
        results: [
          {
            unique_id: "model.dofek.daily_sleep",
            status: "partial success",
            execution_time: 2,
            message: "Some batches failed",
          },
          {
            unique_id: "model.dofek.daily_recovery",
            status: "runtime error",
            execution_time: 1,
            message: "Freshness query failed",
          },
          {
            unique_id: "model.dofek.activity_summary",
            status: "no-op",
            execution_time: 0,
            message: null,
          },
        ],
      },
    });

    expect(parsed.models).toEqual([
      {
        name: "daily_sleep",
        uniqueId: "model.dofek.daily_sleep",
        status: "failed",
        warning: false,
        executionTimeSeconds: 2,
        errorCode: "dbt_model_failed",
        message: "Some batches failed",
      },
      {
        name: "daily_recovery",
        uniqueId: "model.dofek.daily_recovery",
        status: "failed",
        warning: false,
        executionTimeSeconds: 1,
        errorCode: "dbt_model_failed",
        message: "Freshness query failed",
      },
      {
        name: "activity_summary",
        uniqueId: "model.dofek.activity_summary",
        status: "succeeded",
        warning: false,
        executionTimeSeconds: 0,
        errorCode: null,
        message: null,
      },
    ]);
    expect(parsed.succeeded).toBe(false);
  });

  it("uses model resources and ignores absent non-model results", () => {
    const resourceTypedManifest = {
      ...manifest,
      nodes: {
        "seed.dofek.daily_sleep": {
          unique_id: "seed.dofek.daily_sleep",
          name: "daily_sleep",
          resource_type: "seed",
        },
        "model.dofek.daily_sleep": {
          unique_id: "model.dofek.daily_sleep",
          name: "daily_sleep",
          resource_type: "model",
        },
      },
    };
    const parsed = parseDbtRunArtifacts({
      manifest: resourceTypedManifest,
      sources,
      selectedModels: ["daily_sleep"],
      runResults: {
        metadata: { invocation_id: "run-model-resource" },
        results: [
          {
            unique_id: "model.dofek.daily_sleep",
            status: "pass",
            execution_time: 1,
            message: null,
          },
          {
            unique_id: "seed.dofek.daily_sleep",
            status: "error",
            execution_time: 2,
            message: "seed should be ignored",
          },
          {
            unique_id: "test.dofek.unregistered",
            status: "pass",
            execution_time: 0,
            message: null,
          },
        ],
      },
    });

    expect(parsed.models).toEqual([
      {
        name: "daily_sleep",
        uniqueId: "model.dofek.daily_sleep",
        status: "succeeded",
        warning: false,
        executionTimeSeconds: 1,
        errorCode: null,
        message: null,
      },
    ]);

    expect(
      parseDbtRunArtifacts({
        manifest: resourceTypedManifest,
        sources,
        selectedModels: ["daily_sleep"],
        runResults: { metadata: { invocation_id: "run-unattempted-model" }, results: [] },
      }).models,
    ).toEqual([
      {
        name: "daily_sleep",
        uniqueId: "model.dofek.daily_sleep",
        status: "failed",
        warning: false,
        executionTimeSeconds: 0,
        errorCode: "selected_model_unattempted",
        message: "The selected analytics model was not attempted.",
      },
    ]);
  });

  it("rejects malformed or unknown artifact nodes", () => {
    expect(() =>
      parseDbtRunArtifacts({
        manifest,
        sources,
        selectedModels: ["daily_sleep"],
        runResults: { metadata: {}, results: [] },
      }),
    ).toThrow();
    expect(() =>
      parseDbtRunArtifacts({
        manifest,
        sources,
        selectedModels: ["daily_sleep"],
        runResults: {
          metadata: { invocation_id: "run-3" },
          results: [
            {
              unique_id: "model.dofek.unknown",
              status: "error",
              execution_time: 0,
              message: "failed",
            },
          ],
        },
      }),
    ).toThrow(/manifest/i);
    expect(() =>
      parseDbtRunArtifacts({
        manifest,
        sources,
        selectedModels: ["missing_model"],
        runResults: { metadata: { invocation_id: "run-4" }, results: [] },
      }),
    ).toThrow("Selected dbt model missing_model is missing from manifest");
  });
});

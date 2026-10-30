import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestModule, TestSpecification, Vitest } from "vitest/node";
import { z } from "zod";
import {
  checkIntegrationTimingResults,
  timingAssignmentSchema,
} from "./update-integration-test-timings.ts";

const cachedTimingSchema = z.object({
  duration: z.number().finite().nonnegative(),
  failed: z.literal(false),
  lastRun: z.number().int().positive().optional(),
});

/** Export completed whole-file timings through Vitest's public cache API. */
export default class IntegrationTimingReporter implements Reporter {
  #context: Vitest | undefined;
  #run:
    | {
        directory: string;
        inventory: string[];
        startedAt: number;
      }
    | undefined;

  onInit(context: Vitest): void {
    this.#context = context;
  }

  #key(specification: TestSpecification): string {
    if (!this.#context) throw new Error("Timing reporter was not initialized");
    if (specification.project.name !== "integration" || specification.pool !== "forks")
      throw new Error("Timing reporter requires integration forks specifications");
    return `integration:${path.posix.relative(
      this.#context.config.root.replaceAll("\\", "/"),
      specification.moduleId.replaceAll("\\", "/"),
    )}`;
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    this.#run = undefined;
    const context = this.#context;
    if (!context) throw new Error("Timing reporter was not initialized");
    const shard = context.config.shard;
    if (!shard || specifications.some((spec) => spec.project.name !== "integration")) return;
    const startedAt = Date.now();
    const directory = path.resolve(
      context.config.root,
      "reports/integration-sharding",
      `${shard.index}-of-${shard.count}`,
    );
    const keys = specifications.map((specification) => this.#key(specification));
    if (new Set(keys).size !== keys.length)
      throw new Error("Timing run contains duplicate integration specifications");
    this.#run = { directory, inventory: keys.sort(), startedAt };
  }

  onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    unhandledErrors: Parameters<NonNullable<Reporter["onTestRunEnd"]>>[1],
    reason: Parameters<NonNullable<Reporter["onTestRunEnd"]>>[2],
  ): void {
    const run = this.#run;
    this.#run = undefined;
    if (!run) return;
    if (reason !== "passed" || unhandledErrors.length) return;
    const context = this.#context;
    if (!context) throw new Error("Timing reporter was not initialized");
    // Vitest shards inside the pool, after onTestRunStart. Read the assignment only now.
    const assignment = timingAssignmentSchema.parse(
      JSON.parse(readFileSync(path.join(run.directory, "assignment.json"), "utf8")),
    );
    // Cache freshness is required by timing export, not by ordinary test execution.
    if (assignment.cacheExistedBefore || !assignment.cacheEnabled) return;
    if (
      assignment.index !== context.config.shard?.index ||
      assignment.count !== context.config.shard.count ||
      assignment.provenance.vitestVersion !== context.version ||
      JSON.stringify(run.inventory) !== JSON.stringify([...assignment.inventory].sort())
    )
      throw new Error("Timing run inventory does not match the current shard assignment");
    const specifications = modules.map((module) => {
      if (!module.ok()) throw new Error("Timing export requires every selected module to succeed");
      return module.toTestSpecification();
    });
    const keys = specifications.map((specification) => this.#key(specification));
    if (
      new Set(keys).size !== keys.length ||
      JSON.stringify([...keys].sort()) !== JSON.stringify([...assignment.selected].sort())
    )
      throw new Error("Timing completion has duplicate, missing or foreign integration modules");
    const results = specifications.map((specification) => {
      const cached = context.cache.getTestSpecificationResult(specification);
      return [this.#key(specification), cached && cachedTimingSchema.parse(cached)] as const;
    });
    const finishedAt = Date.now();
    if (
      results.some(
        ([, result]) =>
          result?.lastRun === undefined ||
          result.lastRun < run.startedAt ||
          result.lastRun > finishedAt,
      )
    )
      return;
    const completion = checkIntegrationTimingResults(
      {
        schemaVersion: 1,
        assignmentId: assignment.assignmentId,
        provenance: assignment.provenance,
        index: assignment.index,
        count: assignment.count,
        baselineSha256: assignment.baselineSha256,
        runStartedAt: run.startedAt,
        runFinishedAt: finishedAt,
        results,
      },
      assignment,
    );
    writeFileSync(
      path.join(run.directory, "completed-results.json"),
      `${JSON.stringify(completion, null, 2)}\n`,
      { flag: "wx" },
    );
  }
}

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import {
  integrationTimingSourceSha,
  timingAssignmentSchema,
  timingBaselineSchema,
} from "./update-integration-test-timings.ts";

/** Only integration membership changes; Vitests own sorting and all other projects remain intact. */
export default class IntegrationTestSequencer extends BaseSequencer {
  override async shard(specifications: TestSpecification[]): Promise<TestSpecification[]> {
    if (
      !specifications.length ||
      specifications.some((spec) => spec.project.name !== "integration")
    )
      return super.shard(specifications);
    const shard = this.ctx.config.shard;
    if (
      !shard ||
      !Number.isInteger(shard.count) ||
      !Number.isInteger(shard.index) ||
      shard.count < 1 ||
      shard.index < 1 ||
      shard.index > shard.count
    )
      throw new Error(
        "Integration shard requires a positive integral count and one-based index within count",
      );
    const root = this.ctx.config.root;
    const baselinePath = path.resolve(root, "scripts/integration-test-timings.json");
    if (!existsSync(baselinePath))
      throw new Error(
        `Missing integration timing baseline ${baselinePath}; restore the committed baseline or refresh from all four successful timing artifacts`,
      );
    const bytes = readFileSync(baselinePath);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (cause) {
      throw new Error(
        `Malformed integration timing baseline ${baselinePath}; refresh from all four successful timing artifacts`,
        { cause },
      );
    }
    const parsed = timingBaselineSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(
        `Invalid integration timing baseline ${baselinePath}: ${parsed.error.message}; refresh from all four successful timing artifacts`,
      );
    const baseline = parsed.data;
    const weights = new Map(
      baseline.files.map((row) => [`integration:${row.file}`, row.durationMs]),
    );
    const positive = baseline.files
      .map((row) => row.durationMs)
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
    const middle = Math.floor(positive.length / 2);
    const estimate =
      positive.length % 2
        ? Number(positive[middle])
        : Number(positive[middle - 1]) / 2 + Number(positive[middle]) / 2;
    const identities = new Set<string>();
    const files = specifications.map((spec) => {
      if (spec.pool !== "forks")
        throw new Error(
          `Unsupported integration pool ${spec.pool}; review specification identity before changing pools`,
        );
      const file = path.posix.relative(
        root.replaceAll("\\", "/"),
        spec.moduleId.replaceAll("\\", "/"),
      );
      if (
        !path.isAbsolute(spec.moduleId) ||
        !file ||
        file.split("/").some((part) => part === ".." || part === ".") ||
        file.includes(":")
      )
        throw new Error(`Unsupported integration file identity: ${spec.moduleId}`);
      const key = `integration:${file}`;
      if (identities.has(key))
        throw new Error(`Duplicate integration specification identity: ${key}`);
      identities.add(key);
      return { key, spec, durationMs: weights.get(key) ?? estimate };
    });
    files.sort(
      (a, b) => b.durationMs - a.durationMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    const bins: { durationMs: number; files: typeof files }[] = Array.from(
      { length: shard.count },
      () => ({
        durationMs: 0,
        files: [],
      }),
    );
    for (const file of files) {
      let best = bins.reduce((first) => first);
      for (const bin of bins)
        if (
          bin.durationMs < best.durationMs ||
          (bin.durationMs === best.durationMs && bin.files.length < best.files.length)
        )
          best = bin;
      best.files.push(file);
      best.durationMs += file.durationMs;
    }
    const selected = bins[shard.index - 1];
    if (!selected) throw new Error("Integration shard has no allocated bin");
    const assignment = timingAssignmentSchema.parse({
      schemaVersion: 2,
      assignmentId: randomUUID(),
      assignedAt: Date.now(),
      index: shard.index,
      count: shard.count,
      provenance: {
        sourceSha: integrationTimingSourceSha(process.env),
        repository: process.env.GITHUB_REPOSITORY ?? null,
        runId: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : null,
        vitestVersion: this.ctx.version,
        source: this.ctx.config.coverage.enabled
          ? "Vitest integration serial forks with coverage"
          : "Vitest integration serial forks",
        job: process.env.GITHUB_JOB ?? null,
      },
      baselineSha256: createHash("sha256").update(bytes).digest("hex"),
      inventory: [...identities].sort(),
      selected: selected.files.map((file) => file.key).sort(),
      estimated: files
        .filter((file) => !weights.has(file.key))
        .map((file) => file.key)
        .sort(),
      bins: bins.map((bin) => ({ durationMs: bin.durationMs, fileCount: bin.files.length })),
      cacheEnabled: this.ctx.config.cache !== false,
      cacheExistedBefore: specifications.some(
        (specification) => this.ctx.cache.getTestSpecificationResult(specification) !== undefined,
      ),
    });
    const directory = path.resolve(
      root,
      "reports/integration-sharding",
      `${shard.index}-of-${shard.count}`,
    );
    mkdirSync(directory, { recursive: true });
    for (const file of ["completed-results.json", "results.json"])
      rmSync(path.join(directory, file), { force: true });
    writeFileSync(
      path.join(directory, "assignment.json"),
      `${JSON.stringify(assignment, null, 2)}\n`,
    );
    process.stderr.write(
      `Integration shard ${shard.index}/${shard.count}: baseline ${assignment.baselineSha256}; bins ${assignment.bins.map((bin) => `${bin.fileCount} files/${bin.durationMs}ms`).join(", ")}; estimated ${JSON.stringify(assignment.estimated)}\n`,
    );
    return selected.files.map((file) => file.spec);
  }
}

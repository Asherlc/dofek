import fs from "node:fs";
import type { Reporter, TestCase, TestModule, TestSuite } from "vitest/node";
import { diagnosticOperationId, projectDiagnosticError } from "../src/test/ci-diagnostic-fields.ts";

const started = performance.now();
type Entity = TestModule | TestSuite | TestCase;
type Hook = Parameters<NonNullable<Reporter["onHookStart"]>>[0];
export default class IntegrationDiagnosticsReporter implements Reporter {
  #operations = new Map<string, number>();
  #emit(event: string, entity: Entity, hook?: Hook["name"]) {
    if (entity.project.name !== "integration") return;
    const module = entity.type === "module" ? entity : entity.module;
    const file = module.relativeModuleId;
    if (
      !/^(?:src|scripts|packages|analytics)\/[a-zA-Z0-9_./-]+\.integration\.test\.[cm]?[jt]sx?$/.test(
        file,
      ) ||
      file.includes("..")
    )
      return;
    if (!/^-?\d+(?:_\d+)*$/.test(entity.id)) return;
    let operationId = this.#operations.get(entity.id);
    if (operationId === undefined) {
      operationId = diagnosticOperationId();
      this.#operations.set(entity.id, operationId);
    }
    let error: ReturnType<typeof projectDiagnosticError> | undefined;
    if (event.endsWith(".failed")) {
      const failures = entity.type === "test" ? (entity.result().errors ?? []) : entity.errors();
      const projections = failures.slice(0, 8).map(projectDiagnosticError);
      const errors = projections.flatMap((projection) => projection.errors);
      error = {
        errors: errors.slice(0, 8),
        truncated:
          failures.length > 8 ||
          errors.length > 8 ||
          projections.some((projection) => projection.truncated),
      };
    }
    fs.writeSync(
      1,
      `${JSON.stringify({ event, timestamp: new Date().toISOString(), elapsedMs: Math.max(0, performance.now() - started), project: "integration", operationId, file, taskId: entity.id, ...(entity.location ? { line: entity.location.line, column: entity.location.column } : {}), ...(hook ? { hook } : {}), ...(error ? { error } : {}) })}\n`,
    );
  }
  onTestModuleQueued(entity: TestModule) {
    this.#emit("module.queued", entity);
  }
  onTestModuleCollected(entity: TestModule) {
    this.#emit("module.collected", entity);
  }
  onTestModuleStart(entity: TestModule) {
    this.#emit("module.start", entity);
  }
  onTestModuleEnd(entity: TestModule) {
    this.#emit(entity.ok() ? "module.end" : "module.failed", entity);
  }
  onTestSuiteReady(entity: TestSuite) {
    this.#emit("suite.start", entity);
  }
  onTestSuiteResult(entity: TestSuite) {
    this.#emit(entity.ok() ? "suite.end" : "suite.failed", entity);
  }
  onTestCaseReady(entity: TestCase) {
    this.#emit("case.start", entity);
  }
  onTestCaseResult(entity: TestCase) {
    this.#emit(entity.ok() ? "case.end" : "case.failed", entity);
  }
  onHookStart(hook: Hook) {
    this.#emit("hook.start", hook.entity, hook.name);
  }
  onHookEnd(hook: Hook) {
    this.#emit("hook.end", hook.entity, hook.name);
  }
}

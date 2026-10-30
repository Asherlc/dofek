import fs from "node:fs";
import { GenericContainer } from "testcontainers";
import { captureException } from "../lib/error-reporting.ts";
import { diagnosticOperationId, projectDiagnosticError } from "./ci-diagnostic-fields.ts";

type Stage =
  | "startup.begin"
  | "startup.image_ready"
  | "startup.created"
  | "startup.start_inspect_complete"
  | "startup.ready";
export class DiagnosticContainer extends GenericContainer {
  #stage: Stage = "startup.begin";
  #started = 0;
  #operationId = 0;
  #emit(event: Stage | "startup.failed", extra: object = {}) {
    fs.writeSync(
      1,
      `${JSON.stringify({ event, timestamp: new Date().toISOString(), elapsedMs: Math.max(0, performance.now() - this.#started), operationId: this.#operationId, caller: "postgres-test-database", lastStage: this.#stage, ...extra })}\n`,
    );
  }
  #mark(stage: Stage) {
    this.#stage = stage;
    this.#emit(stage);
  }
  protected async beforeContainerCreated() {
    this.#mark("startup.image_ready");
  }
  protected async containerCreated() {
    this.#mark("startup.created");
  }
  protected async containerStarting() {
    this.#mark("startup.start_inspect_complete");
  }
  protected async containerStarted() {
    this.#mark("startup.ready");
  }
  async start() {
    this.#started = performance.now();
    this.#operationId = diagnosticOperationId();
    this.#mark("startup.begin");
    try {
      return await super.start();
    } catch (error) {
      try {
        const diagnostic = projectDiagnosticError(error);
        this.#emit("startup.failed", { diagnostic });
        captureException(new Error("Test container startup failed"), { extra: { diagnostic } });
      } catch {
        captureException(new Error("Test container startup diagnostics failed"));
      }
      throw error;
    }
  }
}

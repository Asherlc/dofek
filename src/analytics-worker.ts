import { createServer, type Server, type ServerResponse } from "node:http";

export type AnalyticsRefreshStep = "analytics-build" | "query-cache-warm";

interface AnalyticsFailure {
  at: Date;
  message: string;
  step: AnalyticsRefreshStep;
}

interface AnalyticsWorkerOptions {
  intervalMilliseconds: number;
  retryDelayMilliseconds: number;
  startupDelayMilliseconds: number;
  now(): Date;
  reportFailure(error: unknown, tags: { analyticsRefreshStep: AnalyticsRefreshStep }): void;
  runAnalyticsBuild(): Promise<void>;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  warmQueryCache(): Promise<void>;
}

interface AnalyticsHealth {
  body: {
    currentStep: AnalyticsRefreshStep | null;
    lastFailure: {
      at: string;
      message: string;
      step: AnalyticsRefreshStep;
    } | null;
    lastSuccessAt: string | null;
    status: "degraded" | "ok" | "starting" | "unhealthy";
  };
  statusCode: 200 | 503;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AnalyticsWorker {
  #currentStep: AnalyticsRefreshStep | null = null;
  #lastCycleSucceeded: boolean | null = null;
  #lastFailure: AnalyticsFailure | null = null;
  #lastSuccessfulAt: Date | null = null;
  readonly #startedAt: Date;
  readonly #options: AnalyticsWorkerOptions;

  constructor(options: AnalyticsWorkerOptions) {
    this.#options = options;
    this.#startedAt = options.now();
  }

  async runCycle(): Promise<boolean> {
    try {
      this.#currentStep = "analytics-build";
      await this.#options.runAnalyticsBuild();
      this.#currentStep = "query-cache-warm";
      await this.#options.warmQueryCache();
      this.#lastSuccessfulAt = this.#options.now();
      this.#lastCycleSucceeded = true;
      this.#currentStep = null;
      return true;
    } catch (error: unknown) {
      const step = this.#currentStep ?? "analytics-build";
      this.#lastFailure = {
        at: this.#options.now(),
        message: errorMessage(error),
        step,
      };
      this.#lastCycleSucceeded = false;
      this.#currentStep = null;
      this.#options.reportFailure(error, { analyticsRefreshStep: step });
      return false;
    }
  }

  getHealth(): AnalyticsHealth {
    const lastFailure = this.#lastFailure
      ? {
          at: this.#lastFailure.at.toISOString(),
          message: this.#lastFailure.message,
          step: this.#lastFailure.step,
        }
      : null;
    const lastSuccessAt = this.#lastSuccessfulAt?.toISOString() ?? null;
    let status: AnalyticsHealth["body"]["status"];

    if (!this.#lastSuccessfulAt) {
      const initialSuccessBudget =
        this.#options.startupDelayMilliseconds +
        this.#options.intervalMilliseconds +
        this.#options.retryDelayMilliseconds;
      const startupAge = this.#options.now().getTime() - this.#startedAt.getTime();
      status = this.#lastFailure || startupAge > initialSuccessBudget ? "unhealthy" : "starting";
    } else {
      const maximumSuccessAge =
        this.#options.intervalMilliseconds + this.#options.retryDelayMilliseconds;
      const successAge = this.#options.now().getTime() - this.#lastSuccessfulAt.getTime();
      if (successAge > maximumSuccessAge) {
        status = "unhealthy";
      } else if (this.#lastCycleSucceeded === false) {
        status = "degraded";
      } else {
        status = "ok";
      }
    }

    return {
      body: {
        currentStep: this.#currentStep,
        lastFailure,
        lastSuccessAt,
        status,
      },
      statusCode: status === "unhealthy" ? 503 : 200,
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#options.startupDelayMilliseconds > 0) {
      await this.#options.sleep(this.#options.startupDelayMilliseconds, signal);
    }

    while (!signal.aborted) {
      const succeeded = await this.runCycle();
      if (signal.aborted) {
        return;
      }
      await this.#options.sleep(
        succeeded ? this.#options.intervalMilliseconds : this.#options.retryDelayMilliseconds,
        signal,
      );
    }
  }
}

function sendJson(response: ServerResponse, health: AnalyticsHealth): void {
  response.writeHead(health.statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(health.body));
}

export function createAnalyticsWorkerHealthServer(worker: AnalyticsWorker): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/readyz") {
      response.writeHead(404);
      response.end();
      return;
    }
    sendJson(response, worker.getHealth());
  });
}

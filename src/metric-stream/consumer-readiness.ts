import { createServer, type Server } from "node:http";

type MetricStreamConsumerReadinessStatus = "ready" | "starting" | "unavailable";

export class MetricStreamConsumerReadiness {
  #state: { status: "starting" | "unavailable" } | { status: "ready"; isActive(): boolean } = {
    status: "starting",
  };

  markReady(isActive: () => boolean): void {
    this.#state = { status: "ready", isActive };
  }

  markUnavailable(): void {
    this.#state = { status: "unavailable" };
  }

  getStatus(): MetricStreamConsumerReadinessStatus {
    const state = this.#state;
    return state.status === "ready" && !state.isActive() ? "unavailable" : state.status;
  }
}

export function createMetricStreamConsumerReadinessServer(
  readiness: MetricStreamConsumerReadiness,
): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/readyz") {
      response.writeHead(404);
      response.end();
      return;
    }

    const status = readiness.getStatus();
    response.writeHead(status === "ready" ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status }));
  });
}

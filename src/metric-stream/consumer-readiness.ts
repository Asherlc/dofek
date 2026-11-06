import { createServer, type Server } from "node:http";

type MetricStreamConsumerReadinessStatus = "ready" | "starting" | "unavailable";

export class MetricStreamConsumerReadiness {
  #status: MetricStreamConsumerReadinessStatus = "starting";

  markGroupJoined(): void {
    this.#status = "ready";
  }

  markUnavailable(): void {
    this.#status = "unavailable";
  }

  getStatus(): MetricStreamConsumerReadinessStatus {
    return this.#status;
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

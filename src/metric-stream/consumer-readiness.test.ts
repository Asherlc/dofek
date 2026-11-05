import { afterEach, describe, expect, it } from "vitest";
import {
  createMetricStreamConsumerReadinessServer,
  MetricStreamConsumerReadiness,
} from "./consumer-readiness.ts";

const servers: Array<ReturnType<typeof createMetricStreamConsumerReadinessServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function requestReadiness(
  readiness: MetricStreamConsumerReadiness,
  path = "/readyz",
  method = "GET",
): Promise<Response> {
  const server = createMetricStreamConsumerReadinessServer(readiness);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP readiness server address");
  }
  return fetch(`http://127.0.0.1:${address.port}${path}`, { method });
}

describe("MetricStreamConsumerReadiness", () => {
  it("does not report ready before transport ownership is established", async () => {
    const readiness = new MetricStreamConsumerReadiness();

    const response = await requestReadiness(readiness);

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ status: "starting" });
  });

  it("reports ready while the transport ownership probe is active", async () => {
    const readiness = new MetricStreamConsumerReadiness();
    readiness.markReady(() => true);

    const response = await requestReadiness(readiness);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
  });

  it("becomes unavailable after a consumer rebalance or disconnect", async () => {
    const readiness = new MetricStreamConsumerReadiness();
    readiness.markReady(() => true);
    readiness.markUnavailable();

    const response = await requestReadiness(readiness);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("checks current ownership at each readiness request", async () => {
    const readiness = new MetricStreamConsumerReadiness();
    let connected = true;
    readiness.markReady(() => connected);
    const ready = await requestReadiness(readiness);
    expect(ready.status).toBe(200);
    await ready.json();
    connected = false;
    const disconnected = await requestReadiness(readiness);
    expect(disconnected.status).toBe(503);
    await expect(disconnected.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("does not probe an owner after it is marked unavailable for cleanup", async () => {
    const readiness = new MetricStreamConsumerReadiness();
    let checks = 0;
    readiness.markReady(() => {
      checks++;
      throw new Error("Closed native owner must not be probed");
    });
    readiness.markUnavailable();
    const response = await requestReadiness(readiness);
    expect(response.status).toBe(503);
    await response.json();
    expect(checks).toBe(0);
  });

  it("returns not found for paths and methods other than the readiness endpoint", async () => {
    const readiness = new MetricStreamConsumerReadiness();
    const pathResponse = await requestReadiness(readiness, "/healthz");
    const methodResponse = await requestReadiness(readiness, "/readyz", "POST");

    expect(pathResponse.status).toBe(404);
    expect(methodResponse.status).toBe(404);
  });
});

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

async function requestReadiness(readiness: MetricStreamConsumerReadiness): Promise<Response> {
  const server = createMetricStreamConsumerReadinessServer(readiness);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP readiness server address");
  }
  return fetch(`http://127.0.0.1:${address.port}/readyz`);
}

describe("MetricStreamConsumerReadiness", () => {
  it("does not report ready before the consumer joins its Kafka group", async () => {
    const readiness = new MetricStreamConsumerReadiness();

    const response = await requestReadiness(readiness);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "starting" });
  });

  it("reports ready while the consumer belongs to its Kafka group", async () => {
    const readiness = new MetricStreamConsumerReadiness();
    readiness.markGroupJoined();

    const response = await requestReadiness(readiness);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
  });

  it("becomes unavailable while the consumer rebalances or disconnects", async () => {
    const readiness = new MetricStreamConsumerReadiness();
    readiness.markGroupJoined();
    readiness.markUnavailable();

    const response = await requestReadiness(readiness);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });
});

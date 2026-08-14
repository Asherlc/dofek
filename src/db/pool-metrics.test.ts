import { describe, expect, it, vi } from "vitest";

const metricsMocks = vi.hoisted(() => {
  const callbacks: Array<{
    name: string;
    callback(result: { observe(value: number): void }): void;
  }> = [];
  const createObservableGauge = vi.fn((name: string) => ({
    addCallback: vi.fn((callback: (result: { observe(value: number): void }) => void) => {
      callbacks.push({ name, callback });
    }),
  }));
  return {
    callbacks,
    createObservableGauge,
    getMeter: vi.fn(() => ({ createObservableGauge })),
  };
});

vi.mock("@opentelemetry/api", () => ({
  metrics: { getMeter: metricsMocks.getMeter },
}));

import { registerPostgresPoolMetrics } from "./pool-metrics.ts";

describe("registerPostgresPoolMetrics", () => {
  it("observes the latest pool without registering duplicate callbacks", () => {
    expect(metricsMocks.callbacks).toHaveLength(3);

    registerPostgresPoolMetrics({
      totalCount: 5,
      idleCount: 1,
      waitingCount: 3,
    });
    registerPostgresPoolMetrics({
      totalCount: 7,
      idleCount: 2,
      waitingCount: 4,
    });
    const observed = new Map<string, number>();

    for (const { name, callback } of metricsMocks.callbacks) {
      callback({
        observe(value) {
          observed.set(name, value);
        },
      });
    }

    expect(observed).toEqual(
      new Map([
        ["postgres.pool.connections.total", 7],
        ["postgres.pool.connections.idle", 2],
        ["postgres.pool.requests.waiting", 4],
      ]),
    );
    expect(metricsMocks.callbacks).toHaveLength(3);
  });

  it("declares pool gauges with operational metadata", () => {
    expect(metricsMocks.getMeter).toHaveBeenCalledWith("dofek-postgres", "1.0.0");
    expect(metricsMocks.createObservableGauge).toHaveBeenCalledWith(
      "postgres.pool.connections.total",
      {
        description: "Total PostgreSQL connections owned by the process pool",
        unit: "{connections}",
      },
    );
    expect(metricsMocks.createObservableGauge).toHaveBeenCalledWith(
      "postgres.pool.connections.idle",
      {
        description: "Idle PostgreSQL connections available in the process pool",
        unit: "{connections}",
      },
    );
    expect(metricsMocks.createObservableGauge).toHaveBeenCalledWith(
      "postgres.pool.requests.waiting",
      {
        description: "Requests waiting to acquire a PostgreSQL connection from the process pool",
        unit: "{requests}",
      },
    );
  });
});

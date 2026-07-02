import { describe, expect, it } from "vitest";
import { loadingPerformanceMonitors } from "./loading-performance-monitors.ts";

describe("loadingPerformanceMonitors", () => {
  it("defines the slow tRPC procedure monitor with percentile and max duration evidence", () => {
    const monitor = loadingPerformanceMonitors.find(
      (candidate) => candidate.id === "loading-slow-trpc-procedure",
    );

    expect(monitor).toBeDefined();
    expect(monitor?.name).toBe("Loading perf: slow tRPC procedure");
    expect(monitor?.type).toBe("Threshold");
    expect(monitor?.operator).toBe("Above");
    expect(monitor?.threshold).toBe(5000);
    expect(monitor?.rangeMinutes).toBe(10);
    expect(monitor?.intervalMinutes).toBe(5);
    expect(monitor?.aplQuery).toContain("db_duration_ms");
    expect(monitor?.aplQuery).toContain("percentile(db_duration_ms, 95)");
    expect(monitor?.aplQuery).toContain("max(total_duration_ms)");
    expect(monitor?.aplQuery).toContain("procedure");
  });

  it("defines the dashboard ClickHouse queue wait monitor grouped by queue", () => {
    const monitor = loadingPerformanceMonitors.find(
      (candidate) => candidate.id === "loading-clickhouse-queue-wait",
    );

    expect(monitor).toBeDefined();
    expect(monitor?.name).toBe("Loading perf: ClickHouse queue wait");
    expect(monitor?.threshold).toBe(1000);
    expect(monitor?.notifyByGroup).toBe(true);
    expect(monitor?.aplQuery).toContain("clickhouse.queue_wait");
    expect(monitor?.aplQuery).toContain("clickhouse.queue.name");
    expect(monitor?.aplQuery).toContain("percentile(['clickhouse.queue.wait_ms'], 95)");
  });

  it("defines the ClickHouse infrastructure error monitor for connection failures", () => {
    const monitor = loadingPerformanceMonitors.find(
      (candidate) => candidate.id === "loading-clickhouse-infrastructure-errors",
    );

    expect(monitor).toBeDefined();
    expect(monitor?.name).toBe("Loading perf: ClickHouse infrastructure errors");
    expect(monitor?.type).toBe("MatchEvent");
    expect(monitor?.aplQuery).toContain("ClickHouse");
    expect(monitor?.aplQuery).toContain("DNS");
    expect(monitor?.aplQuery).toContain("connection refused");
    expect(monitor?.aplQuery).toContain("timeout");
    expect(monitor?.aplQuery).toContain("memory");
  });
});

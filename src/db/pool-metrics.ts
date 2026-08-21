import { metrics } from "@opentelemetry/api";

interface PostgresPoolMetricsSource {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

const meter = metrics.getMeter("dofek-postgres", "1.0.0");

const totalConnections = meter.createObservableGauge("postgres.pool.connections.total", {
  description: "Total PostgreSQL connections owned by the process pool",
  unit: "{connections}",
});

const idleConnections = meter.createObservableGauge("postgres.pool.connections.idle", {
  description: "Idle PostgreSQL connections available in the process pool",
  unit: "{connections}",
});

const waitingRequests = meter.createObservableGauge("postgres.pool.requests.waiting", {
  description: "Requests waiting to acquire a PostgreSQL connection from the process pool",
  unit: "{requests}",
});

let activePool: PostgresPoolMetricsSource | null = null;

totalConnections.addCallback((result) => {
  if (activePool) {
    result.observe(activePool.totalCount);
  }
});
idleConnections.addCallback((result) => {
  if (activePool) {
    result.observe(activePool.idleCount);
  }
});
waitingRequests.addCallback((result) => {
  if (activePool) {
    result.observe(activePool.waitingCount);
  }
});

export function registerPostgresPoolMetrics(pool: PostgresPoolMetricsSource): void {
  activePool = pool;
}

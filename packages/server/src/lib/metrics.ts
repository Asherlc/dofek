import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const trpcProcedureDuration = new Histogram({
  name: "trpc_procedure_duration_seconds",
  help: "Total duration of tRPC procedure calls in seconds",
  labelNames: ["procedure", "type", "cache_hit"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const trpcDbQueryDuration = new Histogram({
  name: "trpc_db_query_duration_seconds",
  help: "Duration of the database query portion of tRPC procedures (excludes cache lookup)",
  labelNames: ["procedure"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const trpcCacheLookupDuration = new Histogram({
  name: "trpc_cache_lookup_duration_seconds",
  help: "Duration of cache lookup in tRPC procedures",
  labelNames: ["procedure", "hit"] as const,
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01],
  registers: [registry],
});

export const cacheHitsTotal = new Counter({
  name: "trpc_cache_hits_total",
  help: "Total number of tRPC cache hits",
  labelNames: ["procedure"] as const,
  registers: [registry],
});

export const cacheMissesTotal = new Counter({
  name: "trpc_cache_misses_total",
  help: "Total number of tRPC cache misses",
  labelNames: ["procedure"] as const,
  registers: [registry],
});

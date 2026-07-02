export type LoadingPerformanceMonitorType = "Threshold" | "MatchEvent";

interface BaseLoadingPerformanceMonitorSpec {
  id: string;
  name: string;
  aplQuery: string;
  rangeMinutes: number;
  intervalMinutes: number;
  owner: string;
  response: string;
}

interface ThresholdLoadingPerformanceMonitorSpec {
  type: "Threshold";
  operator: "Above";
  threshold: number;
  notifyByGroup?: boolean;
  triggerAfterNPositiveResults?: number;
  triggerFromNRuns?: number;
}

interface MatchEventLoadingPerformanceMonitorSpec {
  type: "MatchEvent";
}

export type LoadingPerformanceMonitorSpec = BaseLoadingPerformanceMonitorSpec &
  (ThresholdLoadingPerformanceMonitorSpec | MatchEventLoadingPerformanceMonitorSpec);

const dataset = "dofek-logs";

export const loadingPerformanceMonitors: LoadingPerformanceMonitorSpec[] = [
  {
    id: "loading-slow-trpc-procedure",
    name: "Loading perf: slow tRPC procedure",
    type: "Threshold",
    aplQuery: `['${dataset}']
| where message contains "[trpc] Slow query"
| where isnotnull(db_duration_ms)
| summarize p95_db_duration_ms = percentile(db_duration_ms, 95), max_total_duration_ms = max(total_duration_ms), samples = count() by procedure, bin(_time, 5m)
| where samples >= 3`,
    operator: "Above",
    threshold: 5000,
    rangeMinutes: 10,
    intervalMinutes: 5,
    notifyByGroup: true,
    triggerAfterNPositiveResults: 2,
    triggerFromNRuns: 3,
    owner: "On-call engineer",
    response:
      "Use the loading performance runbook to classify slow procedures before changing query code.",
  },
  {
    id: "loading-clickhouse-queue-wait",
    name: "Loading perf: ClickHouse queue wait",
    type: "Threshold",
    aplQuery: `['${dataset}']
| where name == "clickhouse.queue_wait"
| where isnotnull(['clickhouse.queue.wait_ms'])
| summarize p95_wait_ms = percentile(['clickhouse.queue.wait_ms'], 95), max_wait_ms = max(['clickhouse.queue.wait_ms']), samples = count() by ['clickhouse.queue.name'], bin(_time, 5m)
| where samples >= 3`,
    operator: "Above",
    threshold: 1000,
    rangeMinutes: 10,
    intervalMinutes: 5,
    notifyByGroup: true,
    triggerAfterNPositiveResults: 2,
    triggerFromNRuns: 3,
    owner: "On-call engineer",
    response:
      "Check dashboard queue depth and active ClickHouse work before adding retries or timeouts.",
  },
  {
    id: "loading-clickhouse-infrastructure-errors",
    name: "Loading perf: ClickHouse infrastructure errors",
    type: "MatchEvent",
    aplQuery: `['${dataset}']
| where message contains "ClickHouse"
| where message contains "DNS"
  or message contains "connection refused"
  or message contains "timeout"
  or message contains "memory"
| project _time, level, message, procedure, error`,
    rangeMinutes: 5,
    intervalMinutes: 5,
    owner: "On-call engineer",
    response:
      "Treat infrastructure errors as root-cause evidence; fix connectivity, DNS, timeout source, or memory pressure directly.",
  },
];

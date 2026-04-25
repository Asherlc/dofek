import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";

/**
 * Starts OpenTelemetry instrumentation when OTLP export env vars are set.
 * Returns the SDK instance for shutdown, or undefined if OTel is disabled.
 */
export function startInstrumentation(
  env: Record<string, string | undefined> = process.env,
): NodeSDK | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  const metricsEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;

  const hasTraceExport = Boolean(endpoint || tracesEndpoint);
  const hasLogExport = Boolean(endpoint || logsEndpoint);
  const hasMetricExport = Boolean(endpoint || metricsEndpoint);
  if (!hasTraceExport && !hasLogExport && !hasMetricExport) {
    return undefined;
  }

  const sdk = new NodeSDK({
    spanProcessors: hasTraceExport ? [new BatchSpanProcessor(new OTLPTraceExporter())] : [],
    logRecordProcessors: hasLogExport ? [new BatchLogRecordProcessor(new OTLPLogExporter())] : [],
    metricReader: hasMetricExport
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: 30_000,
        })
      : undefined,
    instrumentations: [
      // Winston logs are bridged via @opentelemetry/winston-transport in logger.ts
      ...(hasTraceExport
        ? [
            getNodeAutoInstrumentations({
              "@opentelemetry/instrumentation-winston": { enabled: false },
            }),
          ]
        : []),
    ],
  });

  sdk.start();

  const shutdown = () => sdk.shutdown().catch(console.error);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return sdk;
}

// Auto-start when loaded via --import
startInstrumentation();

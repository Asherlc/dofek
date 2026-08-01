import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PostHogSpanProcessor } from "@posthog/ai/otel";
import { AiContextSpanProcessor, AiOnlySpanProcessor } from "./lib/ai-observability.ts";
import { POSTHOG_API_KEY, POSTHOG_HOST, POSTHOG_LOGS_URL } from "./lib/posthog-config.ts";

function isProductionDeployment(environment: string | undefined): boolean {
  return environment === "prod" || environment === "production";
}

function createLogRecordProcessors(env: Record<string, string | undefined>): LogRecordProcessor[] {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  const hasAxiomLogExport = Boolean(endpoint || logsEndpoint);
  const hasPostHogLogExport = isProductionDeployment(env.DEPLOY_ENVIRONMENT);

  const processors: LogRecordProcessor[] = [];

  if (hasAxiomLogExport) {
    processors.push(
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter(),
      }),
    );
  }

  if (hasPostHogLogExport) {
    processors.push(
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: POSTHOG_LOGS_URL,
          headers: {
            Authorization: `Bearer ${POSTHOG_API_KEY}`,
          },
        }),
      }),
    );
  }

  return processors;
}

function createSpanProcessors(env: Record<string, string | undefined>): SpanProcessor[] {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const hasAxiomTraceExport = Boolean(endpoint || tracesEndpoint);
  const hasPostHogAiExport = isProductionDeployment(env.DEPLOY_ENVIRONMENT);

  if (!hasAxiomTraceExport && !hasPostHogAiExport) {
    return [];
  }

  const processors: SpanProcessor[] = [new AiContextSpanProcessor()];

  if (hasAxiomTraceExport) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }

  if (hasPostHogAiExport) {
    processors.push(
      new AiOnlySpanProcessor(
        new PostHogSpanProcessor({
          projectToken: POSTHOG_API_KEY,
          host: POSTHOG_HOST,
        }),
      ),
    );
  }

  return processors;
}

/**
 * Starts OpenTelemetry instrumentation when OTLP export env vars or production
 * observability adapters are configured. Returns the SDK instance for shutdown,
 * or undefined if OTel is disabled.
 */
export function startInstrumentation(
  env: Record<string, string | undefined> = process.env,
): NodeSDK | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const metricsEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;

  const spanProcessors = createSpanProcessors(env);
  const hasTraceExport = spanProcessors.length > 0;
  const hasAxiomTraceExport = Boolean(endpoint || tracesEndpoint);
  const logRecordProcessors = createLogRecordProcessors(env);
  const hasLogExport = logRecordProcessors.length > 0;
  const hasMetricExport = Boolean(endpoint || metricsEndpoint);
  if (!hasTraceExport && !hasLogExport && !hasMetricExport) {
    return undefined;
  }

  const serviceName = env.OTEL_SERVICE_NAME ?? "dofek";

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    spanProcessors,
    logRecordProcessors,
    metricReader: hasMetricExport
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: 30_000,
        })
      : undefined,
    instrumentations: [
      // Winston logs are bridged via @opentelemetry/winston-transport in logger.ts
      ...(hasAxiomTraceExport
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

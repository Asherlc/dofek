import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { WinstonInstrumentation } from "@opentelemetry/instrumentation-winston";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";

/**
 * Starts OpenTelemetry instrumentation when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * Returns the SDK instance for shutdown, or undefined if OTel is disabled.
 */
export function startInstrumentation(
  env: Record<string, string | undefined> = process.env,
): NodeSDK | undefined {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return undefined;
  }

  const sdk = new NodeSDK({
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
    instrumentations: [
      new WinstonInstrumentation(),
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
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

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
 * Also checks OTEL_EXPORTER_OTLP_ENDPOINT_unencrypted (SOPS stores non-secret
 * values with this suffix to keep them in plaintext).
 * Returns the SDK instance for shutdown, or undefined if OTel is disabled.
 */
export function startInstrumentation(
  env: Record<string, string | undefined> = process.env,
): NodeSDK | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT_unencrypted;
  if (!endpoint) {
    return undefined;
  }

  // Set the standard env var so the OTel SDK auto-configures from it
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;

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

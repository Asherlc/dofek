import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";

function resolveOtelEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const configured = env[key];
  if (configured) {
    return configured;
  }

  const unencrypted = env[`${key}_unencrypted`];
  if (unencrypted) {
    process.env[key] = unencrypted;
    return unencrypted;
  }

  return undefined;
}

/**
 * Starts OpenTelemetry instrumentation when OTLP export env vars are set.
 * Also checks *_unencrypted variants (SOPS stores non-secret values with this
 * suffix to keep them in plaintext).
 * Returns the SDK instance for shutdown, or undefined if OTel is disabled.
 */
export function startInstrumentation(
  env: Record<string, string | undefined> = process.env,
): NodeSDK | undefined {
  const endpoint = resolveOtelEnvValue(env, "OTEL_EXPORTER_OTLP_ENDPOINT");
  const tracesEndpoint = resolveOtelEnvValue(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  const logsEndpoint = resolveOtelEnvValue(env, "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT");

  const hasTraceExport = Boolean(endpoint || tracesEndpoint);
  const hasLogExport = Boolean(endpoint || logsEndpoint);
  if (!hasTraceExport && !hasLogExport) {
    return undefined;
  }

  const sdk = new NodeSDK({
    spanProcessors: hasTraceExport ? [new BatchSpanProcessor(new OTLPTraceExporter())] : [],
    logRecordProcessors: hasLogExport ? [new BatchLogRecordProcessor(new OTLPLogExporter())] : [],
    instrumentations: [
      // Winston logs are bridged via @opentelemetry/winston-transport in logger.ts
      // (WinstonInstrumentation doesn't work in ESM apps)
      ...(hasTraceExport ? [new HttpInstrumentation(), new ExpressInstrumentation()] : []),
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

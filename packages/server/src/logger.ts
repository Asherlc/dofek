import * as winston from "winston";

function isProductionDeployment(environment: string | undefined): boolean {
  return environment === "prod" || environment === "production";
}

// ── Logger instance ──
// Winston logs are bridged to OTel (Axiom + PostHog) via @opentelemetry/winston-transport.

export const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf((info) => {
          const details = JSON.stringify({
            error_name: info.error_name,
            error_description: info.error_description,
            error_detail: info.error_detail,
            error_cause: info.error_cause,
            http_status: info.http_status,
            oauth_error: info.oauth_error,
          });
          return details === "{}"
            ? `${info.level}: ${info.message}`
            : `${info.level}: ${info.message} ${details}`;
        }),
      ),
    }),
  ],
});

const hasOtelLogExport =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ||
  isProductionDeployment(process.env.DEPLOY_ENVIRONMENT);

if (hasOtelLogExport) {
  import("@opentelemetry/winston-transport")
    .then(({ OpenTelemetryTransportV3 }) => {
      logger.add(new OpenTelemetryTransportV3());
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to initialize Winston OTel transport: ${message}`);
    });
}

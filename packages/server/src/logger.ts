import { WinstonTransport as AxiomTransport } from "@axiomhq/winston";
import * as winston from "winston";

// ── Logger factory ──

export function createLogger(
  env: Record<string, string | undefined> = process.env,
): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message }) => `${level}: ${message}`),
      ),
    }),
  ];

  if (env.AXIOM_TOKEN && env.AXIOM_DATASET) {
    transports.push(
      new AxiomTransport({
        dataset: env.AXIOM_DATASET,
        token: env.AXIOM_TOKEN,
      }),
    );
  }

  return winston.createLogger({
    level: "debug",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(
        ({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`,
      ),
    ),
    transports,
  });
}

// ── Singleton instance ──

export const logger = createLogger();

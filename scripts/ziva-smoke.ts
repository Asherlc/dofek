// cspell:ignore Ziva
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createRateLimitAwareFetch } from "@dofek/provider-http";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import type { TokenSet } from "../src/auth/oauth.ts";
import { createDatabaseFromEnv, type SyncDatabase } from "../src/db/index.ts";
import { loadTokens } from "../src/db/tokens.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import { zivaSubjectFromAccessToken } from "../src/providers/ziva/auth.ts";
import { ZivaMcpClient } from "../src/providers/ziva/client.ts";
import {
  summarizeZivaDiagnostic,
  type ZivaDiagnosticSummary,
} from "../src/providers/ziva/diagnostic.ts";
import type { ZivaMealPayload } from "../src/providers/ziva/schemas.ts";
import { closeResources } from "./close-resources.ts";

const INVALID_ARGUMENTS_MESSAGE =
  "Ziva smoke arguments are invalid. Supply exactly --user-id <UUID> and --date <YYYY-MM-DD>.";
const MISSING_AUTHORIZATION_MESSAGE =
  "No stored Ziva authorization was found for this user. Connect Ziva in Data Sources and try again.";
const EXPIRED_AUTHORIZATION_MESSAGE =
  "Stored Ziva authorization is expired. Reconnect Ziva in Data Sources; this read-only command will not refresh credentials.";
const INVALID_IDENTITY_MESSAGE =
  "Stored Ziva authorization identity is invalid. Reconnect Ziva in Data Sources and try again.";
const SAFE_FAILURE_MESSAGE =
  "Ziva read-only smoke check failed safely. No Dofek or Ziva data was written.";

export interface ZivaSmokeOptions {
  userId: string;
  date: string;
}

interface SmokeDatabase extends Pick<SyncDatabase, "select"> {
  $client: { end(): Promise<unknown> };
}

interface SmokeClient {
  getMealsForDate(date: string): Promise<ZivaMealPayload>;
  close(): Promise<void>;
}

export interface ZivaSmokeRuntime {
  now(): Date;
  fetch: typeof globalThis.fetch;
  createDatabase(): SmokeDatabase;
  loadTokens(database: SmokeDatabase, providerId: string, userId: string): Promise<TokenSet | null>;
  createRateLimitAwareFetch: typeof createRateLimitAwareFetch;
  connectMcpClient(options: {
    accessToken: string;
    fetchFn: typeof globalThis.fetch;
  }): Promise<SmokeClient>;
  captureException: typeof captureException;
  writeOutput(output: string): void;
}

class ZivaSmokeExpectedError extends Error {}

function expectedError(message: string): ZivaSmokeExpectedError {
  return new ZivaSmokeExpectedError(message);
}

export function parseZivaSmokeOptions(args: readonly string[]): ZivaSmokeOptions {
  try {
    const { values } = parseArgs({
      args,
      strict: true,
      options: {
        "user-id": { type: "string", multiple: true },
        date: { type: "string", multiple: true },
      },
    });
    const userIds = values["user-id"];
    const dates = values.date;
    if (userIds?.length !== 1 || dates?.length !== 1)
      throw expectedError(INVALID_ARGUMENTS_MESSAGE);
    return {
      userId: z.uuid().parse(userIds[0]),
      date: z.iso.date().parse(dates[0]),
    };
  } catch {
    throw expectedError(INVALID_ARGUMENTS_MESSAGE);
  }
}

function validateStoredAuthorization(tokens: TokenSet | null, now: Date): TokenSet {
  if (!tokens) throw expectedError(MISSING_AUTHORIZATION_MESSAGE);
  if (!Number.isFinite(tokens.expiresAt.getTime()) || tokens.expiresAt.getTime() <= now.getTime()) {
    throw expectedError(EXPIRED_AUTHORIZATION_MESSAGE);
  }
  const storedSubject = tokens.providerAccountId;
  if (!storedSubject?.trim()) throw expectedError(INVALID_IDENTITY_MESSAGE);
  try {
    if (zivaSubjectFromAccessToken(tokens.accessToken) !== storedSubject) {
      throw expectedError(INVALID_IDENTITY_MESSAGE);
    }
  } catch {
    throw expectedError(INVALID_IDENTITY_MESSAGE);
  }
  return tokens;
}

const productionRuntime: ZivaSmokeRuntime = {
  now: () => new Date(),
  fetch: globalThis.fetch,
  createDatabase: createDatabaseFromEnv,
  loadTokens,
  createRateLimitAwareFetch,
  connectMcpClient: (options) => ZivaMcpClient.connect(options),
  captureException,
  writeOutput: (output) => console.log(output),
};

function safeUnexpectedError(runtime: ZivaSmokeRuntime): Error {
  const error = new Error(SAFE_FAILURE_MESSAGE);
  runtime.captureException(error, { tags: { operation: "ziva-smoke" } });
  return error;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  runtime: ZivaSmokeRuntime = productionRuntime,
): Promise<void> {
  const options = parseZivaSmokeOptions(args);
  let database: SmokeDatabase | undefined;
  let client: SmokeClient | undefined;
  let summary: ZivaDiagnosticSummary | undefined;
  let operationFailure: unknown;
  let cleanupFailure: unknown;

  try {
    database = runtime.createDatabase();
    const tokens = validateStoredAuthorization(
      await runtime.loadTokens(database, "ziva", options.userId),
      runtime.now(),
    );
    const fetchFn = runtime.createRateLimitAwareFetch(runtime.fetch, { providerId: "ziva" });
    client = await runtime.connectMcpClient({ accessToken: tokens.accessToken, fetchFn });
    const payload = await client.getMealsForDate(options.date);
    summary = summarizeZivaDiagnostic(payload, { mealToolPresent: true });
  } catch (error: unknown) {
    operationFailure = error;
  }

  if (database) {
    try {
      await closeResources([
        ...(client ? [{ name: "Ziva MCP client", close: () => client?.close() }] : []),
        { name: "Postgres", close: () => database?.$client.end() },
      ]);
    } catch (error: unknown) {
      cleanupFailure = error;
    }
  }

  if (cleanupFailure !== undefined) throw safeUnexpectedError(runtime);
  if (operationFailure instanceof ZivaSmokeExpectedError) throw operationFailure;
  if (operationFailure !== undefined) throw safeUnexpectedError(runtime);
  if (!summary) throw safeUnexpectedError(runtime);
  runtime.writeOutput(JSON.stringify(summary));
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  const dsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (dsn) Sentry.init({ dsn, skipOpenTelemetrySetup: true });
  main().catch(async (error: unknown) => {
    console.error(`[ziva-smoke] ${error instanceof Error ? error.message : SAFE_FAILURE_MESSAGE}`);
    await Sentry.close(2_000);
    process.exitCode = 1;
  });
}

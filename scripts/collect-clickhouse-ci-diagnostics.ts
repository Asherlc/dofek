import { captureException } from "../src/lib/error-reporting.ts";
import {
  ClickHouseDiagnosticsInputError,
  ClickHouseDiagnosticsOperationError,
  collectClickHouseDiagnostics,
} from "./clickhouse-ci-diagnostics.ts";

try {
  const [containerId, outputDirectory, ...extra] = process.argv.slice(2);
  if (!containerId || !outputDirectory || extra.length)
    throw new ClickHouseDiagnosticsInputError("usage");
  const result = await collectClickHouseDiagnostics({
    containerId,
    outputDirectory,
    credentialUrl: process.env.CLICKHOUSE_URL,
  });
  console.log(JSON.stringify({ failures: result.failures, outputDirectory }));
  if (result.failures.length) process.exitCode = 1;
} catch (error) {
  const safeError =
    error instanceof ClickHouseDiagnosticsInputError ||
    error instanceof ClickHouseDiagnosticsOperationError
      ? error
      : new Error("ClickHouse CI diagnostics could not complete");
  captureException(safeError);
  console.error(safeError.message);
  process.exitCode = 1;
}

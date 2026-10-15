import { captureException } from "../lib/error-reporting.ts";

const ACTIVITY_INTEGRITY_LEASE_NAME = "dofek:activity-data-integrity-repair:v1";

type ConnectionErrorListener = (error: Error) => void;

export interface ActivityIntegrityLeaseDatabase {
  $client: {
    connect(): Promise<{
      off(event: "error", listener: ConnectionErrorListener): unknown;
      on(event: "error", listener: ConnectionErrorListener): unknown;
      query(query: string, values?: unknown[]): Promise<{ rows: object[] }>;
      release(destroy?: boolean): void;
    }>;
  };
}

export async function withActivityIntegrityLease<T>(
  db: ActivityIntegrityLeaseDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const connection = await db.$client.connect();
  let sessionError: Error | undefined;
  const onSessionError: ConnectionErrorListener = (error) => {
    sessionError ??= error;
    captureException(error, { tags: { source: "activity-integrity-lease" } });
  };
  connection.on("error", onSessionError);
  let acquired = false;
  let outcome: { succeeded: true; value: T } | { succeeded: false; error: unknown };
  try {
    const result = await connection.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired",
      [ACTIVITY_INTEGRITY_LEASE_NAME],
    );
    acquired =
      result.rows[0] != null && "acquired" in result.rows[0] && result.rows[0].acquired === true;
    if (!acquired) throw new Error("activity integrity repair is already running");
    outcome = { succeeded: true, value: await operation() };
  } catch (error) {
    outcome = { succeeded: false, error };
  }

  let cleanupError: unknown;
  if (sessionError !== undefined) {
    cleanupError = new Error("activity integrity lease was lost with its PostgreSQL session", {
      cause: sessionError,
    });
  }
  try {
    if (acquired && cleanupError === undefined) {
      await connection.query("SELECT pg_advisory_unlock(hashtextextended($1::text, 0))", [
        ACTIVITY_INTEGRITY_LEASE_NAME,
      ]);
    }
  } catch (error) {
    cleanupError = error;
    captureException(error);
  }
  try {
    if (cleanupError === undefined) {
      connection.off("error", onSessionError);
      connection.release();
    } else connection.release(true);
  } catch (error) {
    cleanupError ??= error;
    captureException(error);
  }

  if (!outcome.succeeded) throw outcome.error;
  if (cleanupError !== undefined) throw cleanupError;
  return outcome.value;
}

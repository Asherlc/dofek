const ACTIVITY_INTEGRITY_LEASE_NAME = "dofek:activity-data-integrity-repair:v1";

interface ActivityIntegrityLeaseDatabase {
  $client: {
    connect(): Promise<{
      query(query: string, values?: unknown[]): Promise<{ rows: object[] }>;
      release(): void;
    }>;
  };
}

export async function withActivityIntegrityLease<T>(
  db: ActivityIntegrityLeaseDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const connection = await db.$client.connect();
  let acquired = false;
  try {
    const result = await connection.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired",
      [ACTIVITY_INTEGRITY_LEASE_NAME],
    );
    acquired =
      result.rows[0] != null && "acquired" in result.rows[0] && result.rows[0].acquired === true;
    if (!acquired) throw new Error("activity integrity repair is already running");
    return await operation();
  } finally {
    if (acquired) {
      await connection.query("SELECT pg_advisory_unlock(hashtextextended($1::text, 0))", [
        ACTIVITY_INTEGRITY_LEASE_NAME,
      ]);
    }
    connection.release();
  }
}

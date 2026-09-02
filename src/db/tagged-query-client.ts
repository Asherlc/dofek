import { Pool } from "pg";

type QueryValue = string | number | boolean | Date | null | undefined;
type QueryRow = Record<string, unknown>;

export type TaggedQueryExecutor = {
  <TRow extends QueryRow = QueryRow>(
    strings: TemplateStringsArray,
    ...values: QueryValue[]
  ): Promise<TRow[]>;
  unsafe: <TRow extends QueryRow = QueryRow>(queryText: string) => Promise<TRow[]>;
};

export type TaggedQueryClient = TaggedQueryExecutor & {
  end: () => Promise<void>;
  transaction: <T>(operation: (transaction: TaggedQueryExecutor) => Promise<T>) => Promise<T>;
};

function buildQueryText(strings: TemplateStringsArray, values: QueryValue[]): string {
  let queryText = strings[0] ?? "";
  for (const [index, value] of values.entries()) {
    void value;
    queryText += `$${index + 1}${strings[index + 1] ?? ""}`;
  }
  return queryText;
}

export function createTaggedQueryClient(
  connectionString: string,
  maximumConnections = 1,
): TaggedQueryClient {
  const pool = new Pool({
    connectionString,
    max: maximumConnections,
  });

  const query = createTaggedQueryExecutor(pool);

  const client: TaggedQueryClient = Object.assign(query, {
    end: async (): Promise<void> => {
      await pool.end();
    },
    transaction: async <T>(
      operation: (transaction: TaggedQueryExecutor) => Promise<T>,
    ): Promise<T> => {
      const transactionClient = await pool.connect();
      try {
        await transactionClient.query("BEGIN");
        const result = await operation(createTaggedQueryExecutor(transactionClient));
        await transactionClient.query("COMMIT");
        return result;
      } catch (error) {
        await transactionClient.query("ROLLBACK");
        throw error;
      } finally {
        transactionClient.release();
      }
    },
  });

  return client;
}

function createTaggedQueryExecutor(queryable: Pick<Pool, "query">): TaggedQueryExecutor {
  const query = async <TRow extends QueryRow = QueryRow>(
    strings: TemplateStringsArray,
    ...values: QueryValue[]
  ): Promise<TRow[]> => {
    const result = await queryable.query<TRow>(buildQueryText(strings, values), values);
    return result.rows;
  };

  query.unsafe = async <TRow extends QueryRow = QueryRow>(queryText: string): Promise<TRow[]> => {
    const result = await queryable.query<TRow>(queryText);
    return result.rows;
  };

  return query;
}

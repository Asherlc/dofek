import { Pool } from "pg";

type QueryValue = string | number | boolean | Date | null | undefined;
type QueryRow = Record<string, unknown>;

export type TaggedQueryClient = {
  <TRow extends QueryRow = QueryRow>(
    strings: TemplateStringsArray,
    ...values: QueryValue[]
  ): Promise<TRow[]>;
  unsafe: <TRow extends QueryRow = QueryRow>(queryText: string) => Promise<TRow[]>;
  end: () => Promise<void>;
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

  const query = async <TRow extends QueryRow = QueryRow>(
    strings: TemplateStringsArray,
    ...values: QueryValue[]
  ): Promise<TRow[]> => {
    const result = await pool.query<TRow>(buildQueryText(strings, values), values);
    return result.rows;
  };

  query.unsafe = async <TRow extends QueryRow = QueryRow>(queryText: string): Promise<TRow[]> => {
    const result = await pool.query<TRow>(queryText);
    return result.rows;
  };

  query.end = async (): Promise<void> => {
    await pool.end();
  };

  return query;
}

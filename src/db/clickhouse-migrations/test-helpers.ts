import type { ClickHouseCommandClient } from "../clickhouse.ts";

type QueryOptions = Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0];

export interface FakeClickHouseMigrationClient {
  client: ClickHouseCommandClient;
  commands: string[];
}

/**
 * Builds a ClickHouse migration client whose `system.columns` lookups are driven by a
 * `database.table.column` keyed count map, and which records every executed command.
 *
 * Table-existence probes always report the table as present so that statements gated on
 * `waitForClickHouseTable` run immediately; that waiting is covered by the statement runner.
 */
export function makeFakeClickHouseMigrationClient(
  columnCounts: Record<string, number> = {},
): FakeClickHouseMigrationClient {
  const commands: string[] = [];
  const client: ClickHouseCommandClient = {
    command: async ({ query }) => {
      commands.push(query);
    },
    query: async <TRow extends object>({ query_params }: QueryOptions) => ({
      json: async (): Promise<TRow[]> =>
        JSON.parse(
          JSON.stringify([
            {
              table_count: 1,
              column_count:
                columnCounts[
                  `${String(query_params?.database)}.${String(query_params?.table)}.${String(query_params?.column)}`
                ] ?? 0,
            },
          ]),
        ),
    }),
  };
  return { client, commands };
}

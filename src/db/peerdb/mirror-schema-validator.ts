import { z } from "zod";
import type { PeerDbMirrorContract } from "./mirror-contracts.ts";

interface SourcePostgresCatalogClient {
  query(queryText: string, values?: unknown[]): Promise<unknown>;
}

interface ClickHouseCatalogClient {
  query(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
  }): Promise<{ json(): Promise<unknown> }>;
}

type PeerDbMirrorSchemaIssueKind =
  | "missing_source_table"
  | "missing_destination_table"
  | "missing_destination_columns"
  | "unknown_excluded_source_columns"
  | "missing_peerdb_metadata_columns";

export interface PeerDbMirrorSchemaIssue {
  columns: string[];
  destinationTableIdentifier: string;
  kind: PeerDbMirrorSchemaIssueKind;
  mirrorName: string;
  sourceTableIdentifier: string;
}

export interface PeerDbMirrorSchemaReport {
  issues: PeerDbMirrorSchemaIssue[];
}

interface PeerDbMirrorSchemaValidationOptions {
  clickHouseClient: ClickHouseCatalogClient;
  contracts: readonly PeerDbMirrorContract[];
  sourcePostgresClient: SourcePostgresCatalogClient;
}

const sourceColumnRowsSchema = z.object({
  rows: z.array(
    z.object({
      column_name: z.string(),
      table_name: z.string(),
      table_schema: z.string(),
    }),
  ),
});
const destinationColumnRowsSchema = z.array(
  z.object({
    database: z.string(),
    name: z.string(),
    table: z.string(),
  }),
);
const peerDbMetadataColumns = [
  "_peerdb_is_deleted",
  "_peerdb_synced_at",
  "_peerdb_version",
] as const;

function relationParts(identifier: string): [schema: string, table: string] {
  const parts = identifier.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`PeerDB source table must be schema-qualified: ${identifier}`);
  }
  return [parts[0], parts[1]];
}

function relationKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function addColumn(columnsByRelation: Map<string, Set<string>>, relation: string, column: string) {
  const columns = columnsByRelation.get(relation) ?? new Set<string>();
  columns.add(column);
  columnsByRelation.set(relation, columns);
}

async function readSourceColumns(
  client: SourcePostgresCatalogClient,
  contracts: readonly PeerDbMirrorContract[],
): Promise<Map<string, Set<string>>> {
  const sourceRelations = contracts.flatMap(({ tableMappings }) =>
    tableMappings.map(({ sourceTableIdentifier }) => relationParts(sourceTableIdentifier)),
  );
  const schemas = [...new Set(sourceRelations.map(([schema]) => schema))];
  const tables = [...new Set(sourceRelations.map(([, table]) => table))];
  const result = sourceColumnRowsSchema.parse(
    await client.query(
      `SELECT table_schema, table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = ANY($1::text[])
         AND table_name = ANY($2::text[])
       ORDER BY table_schema, table_name, ordinal_position`,
      [schemas, tables],
    ),
  );
  const columnsByRelation = new Map<string, Set<string>>();
  for (const row of result.rows) {
    addColumn(columnsByRelation, relationKey(row.table_schema, row.table_name), row.column_name);
  }
  return columnsByRelation;
}

async function readDestinationColumns(
  client: ClickHouseCatalogClient,
  contracts: readonly PeerDbMirrorContract[],
): Promise<Map<string, Set<string>>> {
  const databases = [...new Set(contracts.map(({ destinationDatabase }) => destinationDatabase))];
  const tables = [
    ...new Set(
      contracts.flatMap(({ tableMappings }) =>
        tableMappings.map(({ destinationTableIdentifier }) => destinationTableIdentifier),
      ),
    ),
  ];
  const result = await client.query({
    query: `SELECT database, table, name
      FROM system.columns
      WHERE database IN ({databases:Array(String)})
        AND table IN ({tables:Array(String)})
      ORDER BY database, table, position`,
    format: "JSONEachRow",
    query_params: { databases, tables },
  });
  const rows = destinationColumnRowsSchema.parse(await result.json());
  const columnsByRelation = new Map<string, Set<string>>();
  for (const row of rows) {
    addColumn(columnsByRelation, relationKey(row.database, row.table), row.name);
  }
  return columnsByRelation;
}

function sortedDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

export async function inspectPeerDbMirrorSchemas(
  options: PeerDbMirrorSchemaValidationOptions,
): Promise<PeerDbMirrorSchemaReport> {
  const [sourceColumnsByRelation, destinationColumnsByRelation] = await Promise.all([
    readSourceColumns(options.sourcePostgresClient, options.contracts),
    readDestinationColumns(options.clickHouseClient, options.contracts),
  ]);
  const issues: PeerDbMirrorSchemaIssue[] = [];

  for (const contract of options.contracts) {
    for (const mapping of contract.tableMappings) {
      const destinationTableIdentifier = relationKey(
        contract.destinationDatabase,
        mapping.destinationTableIdentifier,
      );
      const issueBase = {
        destinationTableIdentifier,
        mirrorName: contract.name,
        sourceTableIdentifier: mapping.sourceTableIdentifier,
      };
      const sourceColumns = sourceColumnsByRelation.get(mapping.sourceTableIdentifier);
      const destinationColumns = destinationColumnsByRelation.get(destinationTableIdentifier);
      if (!sourceColumns) {
        issues.push({ ...issueBase, columns: [], kind: "missing_source_table" });
      }
      if (!destinationColumns) {
        issues.push({ ...issueBase, columns: [], kind: "missing_destination_table" });
      }
      if (!sourceColumns || !destinationColumns) continue;

      const excludedColumns = new Set(mapping.exclude);
      const allowedAbsentExcludedSourceColumns = new Set(
        mapping.allowAbsentExcludedSourceColumns ?? [],
      );
      const unknownExcludedSourceColumns = sortedDifference(
        excludedColumns,
        new Set([...sourceColumns, ...allowedAbsentExcludedSourceColumns]),
      );
      if (unknownExcludedSourceColumns.length > 0) {
        issues.push({
          ...issueBase,
          columns: unknownExcludedSourceColumns,
          kind: "unknown_excluded_source_columns",
        });
      }
      const projectedSourceColumns = new Set(
        [...sourceColumns].filter((column) => !excludedColumns.has(column)),
      );
      const missingDestinationColumns = sortedDifference(
        projectedSourceColumns,
        destinationColumns,
      );
      if (missingDestinationColumns.length > 0) {
        issues.push({
          ...issueBase,
          columns: missingDestinationColumns,
          kind: "missing_destination_columns",
        });
      }
      const missingPeerDbMetadataColumns = sortedDifference(
        new Set(peerDbMetadataColumns),
        destinationColumns,
      );
      if (missingPeerDbMetadataColumns.length > 0) {
        issues.push({
          ...issueBase,
          columns: missingPeerDbMetadataColumns,
          kind: "missing_peerdb_metadata_columns",
        });
      }
    }
  }

  return { issues };
}

export async function assertPeerDbMirrorSchemasCompatible(
  options: PeerDbMirrorSchemaValidationOptions,
): Promise<void> {
  const report = await inspectPeerDbMirrorSchemas(options);
  if (report.issues.length === 0) return;

  const details = report.issues
    .map(
      (issue) =>
        `${issue.mirrorName} ${issue.sourceTableIdentifier} -> ${issue.destinationTableIdentifier} ${issue.kind}=[${issue.columns.join(",")}]`,
    )
    .join("; ");
  throw new Error(`PeerDB mirror schema contract is incompatible: ${details}`);
}

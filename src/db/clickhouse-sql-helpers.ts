export const peerDbMetadataColumnDefinitions = `  _peerdb_synced_at DateTime64(9) DEFAULT now(),
  _peerdb_is_deleted Int8 DEFAULT 0,
  _peerdb_version Int64 DEFAULT 0`;

const peerDbMetadataColumns = [
  "_peerdb_synced_at DateTime64(9) DEFAULT now()",
  "_peerdb_is_deleted Int8 DEFAULT 0",
  "_peerdb_version Int64 DEFAULT 0",
] as const;

export function peerDbMetadataColumnAlterStatements(tableName: string): string[] {
  return peerDbMetadataColumns.map(
    (metadataColumn) => `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${metadataColumn}`,
  );
}

export function replacingMergeTreeTable(orderBy: string): string {
  return `ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY ${orderBy}
SETTINGS allow_nullable_key = 1`;
}

export function standardViewHeader(viewName: string): string {
  return `CREATE VIEW IF NOT EXISTS ${viewName}
AS`;
}

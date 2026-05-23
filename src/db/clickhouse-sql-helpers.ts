export const peerDbMetadataColumnDefinitions = `  _peerdb_synced_at DateTime64(9) DEFAULT now(),
  _peerdb_is_deleted Int8 DEFAULT 0,
  _peerdb_version Int64 DEFAULT 0`;

export function replacingMergeTreeTable(orderBy: string): string {
  return `ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY ${orderBy}
SETTINGS allow_nullable_key = 1`;
}

export function standardViewHeader(viewName: string): string {
  return `CREATE VIEW IF NOT EXISTS ${viewName}
AS`;
}

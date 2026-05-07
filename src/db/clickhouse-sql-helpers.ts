export const peerDbMetadataColumnDefinitions = `  _peerdb_synced_at DateTime64(9) DEFAULT now(),
  _peerdb_is_deleted Int8 DEFAULT 0,
  _peerdb_version Int64 DEFAULT 0`;

export function replacingMergeTreeTable(orderBy: string): string {
  return `ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY ${orderBy}
SETTINGS allow_nullable_key = 1`;
}

export function refreshableMergeTreeViewHeader(
  viewName: string,
  orderBy: string,
  refreshOffset = "",
): string {
  const offsetClause = refreshOffset ? ` OFFSET ${refreshOffset}` : "";
  return `CREATE MATERIALIZED VIEW IF NOT EXISTS ${viewName}
REFRESH EVERY 1 MINUTE${offsetClause}
ENGINE = MergeTree
ORDER BY ${orderBy}
SETTINGS allow_nullable_key = 1
AS`;
}

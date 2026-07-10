export const peerDbMetadataColumnDefinitions = `  _peerdb_synced_at DateTime64(9) DEFAULT now(),
  _peerdb_is_deleted Int8 DEFAULT 0,
  _peerdb_version Int64 DEFAULT 0`;

export function replacingMergeTreeTable(orderBy: string): string {
  return `ENGINE = ReplacingMergeTree(_peerdb_version)
ORDER BY ${orderBy}
SETTINGS allow_nullable_key = 1`;
}

export function standardViewHeader(viewName: string): string {
  assertClickHouseQualifiedName(viewName);
  return `CREATE VIEW IF NOT EXISTS ${viewName}
AS`;
}

export function refreshableMergeTreeViewHeader(
  viewName: string,
  orderBy: string,
  refreshEvery: string,
): string {
  assertClickHouseQualifiedName(viewName);
  assertClickHouseOrderBy(orderBy);
  assertClickHouseRefreshEvery(refreshEvery);
  return `CREATE MATERIALIZED VIEW IF NOT EXISTS ${viewName}
REFRESH EVERY ${refreshEvery}
ENGINE = MergeTree
ORDER BY ${orderBy}
SETTINGS allow_nullable_key = 1
AS`;
}

function assertClickHouseQualifiedName(value: string): void {
  if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Invalid ClickHouse qualified name: ${value}`);
  }
}

function assertClickHouseOrderBy(value: string): void {
  if (!/^\([A-Za-z_][A-Za-z0-9_]*(?:,\s*[A-Za-z_][A-Za-z0-9_]*)*\)$/.test(value)) {
    throw new Error(`Invalid ClickHouse ORDER BY expression: ${value}`);
  }
}

function assertClickHouseRefreshEvery(value: string): void {
  if (!/^[1-9][0-9]*\s+(?:SECOND|MINUTE|HOUR|DAY)$/.test(value)) {
    throw new Error(`Invalid ClickHouse refresh interval: ${value}`);
  }
}

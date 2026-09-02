import { DATA_TYPE_LABELS, type ProviderStats } from "@dofek/providers/provider-stats";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { ProviderSyncHistoryEntry } from "../components/ProviderSyncHistoryEntry.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { toFilterOptions } from "../lib/provider-detail-filter-options.ts";
import { trpc } from "../lib/trpc.ts";
import {
  pruneEmptyFilters,
  RecordFiltersGrid,
  useDebouncedFilters,
} from "./ProviderDetailFilters.tsx";
import { formatCellValue, formatColumnName } from "./provider-detail-format.ts";
import { RecordDetailModal } from "./RecordDetailModal.tsx";

type DataType = (typeof DATA_TYPE_LABELS)[number]["key"];

const SYNC_HISTORY_FILTER_COLUMNS = [
  { key: "syncedAt", label: "Time" },
  { key: "dataType", label: "Type" },
  { key: "status", label: "Status" },
  { key: "recordCount", label: "Records" },
  { key: "durationMs", label: "Duration" },
  { key: "errorMessage", label: "Error" },
  { key: "authFailureReason", label: "Auth Failure" },
  { key: "id", label: "Id" },
] as const;

export function SyncHistory({
  providerId,
  providerName,
}: {
  providerId: string;
  providerName: string;
}) {
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const debouncedFilters = useDebouncedFilters(filters);
  const activeFilters = useMemo(() => pruneEmptyFilters(debouncedFilters), [debouncedFilters]);
  const pageSize = 20;
  const filterOptionsQuery = trpc.providerDetail.logFilterOptions.useQuery({ providerId });

  const logs = trpc.providerDetail.logs.useQuery({
    providerId,
    limit: pageSize,
    offset: page * pageSize,
    filters: activeFilters,
  });

  const rows = logs.data ?? [];

  const handleFilterChange = useCallback((key: string, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  }, []);

  const getFilterOptions = useCallback(
    (columnKey: string) => toFilterOptions(columnKey, filterOptionsQuery.data?.[columnKey]),
    [filterOptionsQuery.data],
  );

  return (
    <section>
      <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">Sync History</h2>

      {logs.isError ? <QueryStatePanel error={logs.error} height={80} /> : null}

      {logs.isLoading && logs.data === undefined ? (
        <QueryStatePanel variant="loading" height={80} />
      ) : logs.isError && logs.data === undefined ? null : rows.length === 0 &&
        Object.keys(activeFilters).length === 0 ? (
        <div className="text-xs text-subtle">No sync history yet.</div>
      ) : (
        <>
          <details className="mb-3 rounded border border-border bg-surface px-3 py-2 text-xs">
            <summary className="w-fit cursor-pointer text-foreground">Filter history</summary>
            <div className="mt-3">
              <RecordFiltersGrid
                columns={SYNC_HISTORY_FILTER_COLUMNS}
                filters={filters}
                onFilterChange={handleFilterChange}
                getOptions={getFilterOptions}
              />
            </div>
          </details>

          <div className="space-y-2">
            {rows.length === 0 ? (
              <div className="rounded border border-border bg-surface px-4 py-6 text-xs text-subtle">
                No sync history matches the current filters.
              </div>
            ) : (
              rows.map((row) => (
                <ProviderSyncHistoryEntry key={row.id} providerName={providerName} entry={row} />
              ))
            )}
          </div>

          <div className="flex items-center justify-between mt-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="text-xs px-3 py-1 rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
            >
              Previous
            </button>
            <span className="text-xs text-subtle">Page {page + 1}</span>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={rows.length < pageSize}
              className="text-xs px-3 py-1 rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function getStatCount(stats: ProviderStats, key: DataType): number {
  return stats[key];
}

function RecordsSectionShell({
  children,
  providerId,
  hasClinicalRecords,
}: {
  children: ReactNode;
  providerId: string;
  hasClinicalRecords: boolean;
}) {
  return (
    <section>
      <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-2">Records</h2>
      {providerId === "apple_health" ? (
        <div className="mb-3 rounded border border-border bg-surface px-3 py-3 text-xs text-subtle">
          <p>Clinical records are optional, read-only, and sync only during an explicit sync.</p>
          {hasClinicalRecords ? (
            <Link to="/clinical-records" className="mt-2 inline-block text-accent hover:underline">
              View clinical records
            </Link>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function RecordsBrowser({
  providerId,
  stats,
}: {
  providerId: string;
  stats: ProviderStats | undefined;
}) {
  const availability = trpc.providerDetail.availableDataTypes.useQuery({ providerId });
  const hasClinicalRecords =
    (stats?.clinicalRecords ?? 0) > 0 || (availability.data?.includes("clinicalRecords") ?? false);
  const availableTypes = DATA_TYPE_LABELS.filter((dataType) =>
    availability.data?.includes(dataType.key),
  );

  const [selectedTab, setSelectedTab] = useState<DataType>("activities");
  const activeTab = useMemo(() => {
    if (availableTypes.some((dataType) => dataType.key === selectedTab)) {
      return selectedTab;
    }
    return availableTypes[0]?.key ?? "activities";
  }, [availableTypes, selectedTab]);

  if (availability.isLoading) {
    return (
      <RecordsSectionShell providerId={providerId} hasClinicalRecords={hasClinicalRecords}>
        <div className="text-xs text-subtle">Loading records...</div>
      </RecordsSectionShell>
    );
  }

  if (availability.isError) {
    return (
      <RecordsSectionShell providerId={providerId} hasClinicalRecords={hasClinicalRecords}>
        <QueryStatePanel error={availability.error} height={80} />
      </RecordsSectionShell>
    );
  }

  if (availableTypes.length === 0) {
    return (
      <RecordsSectionShell providerId={providerId} hasClinicalRecords={hasClinicalRecords}>
        <div className="text-xs text-subtle">No records yet for this provider.</div>
      </RecordsSectionShell>
    );
  }

  const recordPanelId = `provider-records-panel-${providerId}`;

  return (
    <RecordsSectionShell providerId={providerId} hasClinicalRecords={hasClinicalRecords}>
      <div role="tablist" aria-label="Record types" className="flex flex-wrap gap-1 mb-3">
        {availableTypes.map((dataType) => {
          const tabId = `provider-records-tab-${providerId}-${dataType.key}`;
          return (
            <button
              key={dataType.key}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={activeTab === dataType.key}
              aria-controls={recordPanelId}
              onClick={() => setSelectedTab(dataType.key)}
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                activeTab === dataType.key
                  ? "bg-accent/15 text-foreground"
                  : "bg-accent/10 text-subtle hover:text-foreground"
              }`}
            >
              {dataType.label}
              {stats && getStatCount(stats, dataType.key) > 0 && (
                <span className="ml-1 text-dim">
                  ({getStatCount(stats, dataType.key).toLocaleString()})
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        id={recordPanelId}
        role="tabpanel"
        aria-labelledby={`provider-records-tab-${providerId}-${activeTab}`}
      >
        <RecordsTable
          key={`${providerId}:${activeTab}`}
          providerId={providerId}
          dataType={activeTab}
        />
      </div>
    </RecordsSectionShell>
  );
}

function RecordsTable({ providerId, dataType }: { providerId: string; dataType: DataType }) {
  const [page, setPage] = useState(0);
  const [selectedRecord, setSelectedRecord] = useState<Record<string, unknown> | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const debouncedFilters = useDebouncedFilters(filters);
  const activeFilters = useMemo(() => pruneEmptyFilters(debouncedFilters), [debouncedFilters]);
  const pageSize = 25;
  const filterOptionsQuery = trpc.providerDetail.recordFilterOptions.useQuery({
    providerId,
    dataType,
  });

  const records = trpc.providerDetail.records.useQuery({
    providerId,
    dataType,
    limit: pageSize,
    offset: page * pageSize,
    filters: activeFilters,
  });

  const rows = records.isError ? [] : (records.data?.rows ?? []);
  const visibleColumns = records.data?.columns ?? [];
  const filterColumnNames = records.data?.filterColumns ?? visibleColumns;

  const handleFilterChange = useCallback((key: string, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  }, []);

  const filterColumns = useMemo(
    () => filterColumnNames.map((column) => ({ key: column, label: formatColumnName(column) })),
    [filterColumnNames],
  );

  const getFilterOptions = useCallback(
    (columnKey: string) => toFilterOptions(columnKey, filterOptionsQuery.data?.[columnKey]),
    [filterOptionsQuery.data],
  );

  const hasRaw = rows.some((row) => Object.hasOwn(row, "raw"));

  if (records.isLoading) {
    return <QueryStatePanel variant="loading" height={80} />;
  }

  if (records.isError) {
    return <QueryStatePanel error={records.error} height={80} />;
  }

  const emptyMessage =
    Object.keys(activeFilters).length === 0
      ? "No records found."
      : "No records match the current filters.";

  return (
    <>
      <RecordFiltersGrid
        columns={filterColumns}
        filters={filters}
        onFilterChange={handleFilterChange}
        getOptions={getFilterOptions}
      />

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-subtle">
              {visibleColumns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="text-left px-3 py-2 font-medium whitespace-nowrap"
                >
                  {formatColumnName(column)}
                </th>
              ))}
              {hasRaw && (
                <th scope="col" className="text-left px-3 py-2 font-medium">
                  Data
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(visibleColumns.length + (hasRaw ? 1 : 0), 1)}
                  className="px-3 py-6 text-subtle"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={String(row.id ?? row.date ?? index)}
                  className="border-b border-border/50 hover:bg-surface-hover transition-colors cursor-pointer"
                  onClick={() => setSelectedRecord(row)}
                >
                  {visibleColumns.map((column) => (
                    <td
                      key={column}
                      className="px-3 py-2 text-foreground whitespace-nowrap max-w-xs truncate"
                    >
                      {formatCellValue(row[column])}
                    </td>
                  ))}
                  {hasRaw && (
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedRecord(row);
                        }}
                        className="text-xs text-dim hover:text-muted transition-colors"
                      >
                        View
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-2">
        <button
          type="button"
          onClick={() => setPage((currentPage) => Math.max(0, currentPage - 1))}
          disabled={page === 0}
          className="text-xs px-3 py-1 rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
        >
          Previous
        </button>
        <span className="text-xs text-subtle">Page {page + 1}</span>
        <button
          type="button"
          onClick={() => setPage((currentPage) => currentPage + 1)}
          disabled={rows.length < pageSize}
          className="text-xs px-3 py-1 rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
        >
          Next
        </button>
      </div>

      {selectedRecord && (
        <RecordDetailModal
          record={selectedRecord}
          onClose={() => setSelectedRecord(null)}
          activityId={
            dataType === "activities" && typeof selectedRecord.id === "string"
              ? selectedRecord.id
              : undefined
          }
        />
      )}
    </>
  );
}

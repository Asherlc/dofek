import { Link, useParams } from "@tanstack/react-router";
import type { AppRouterOutputs } from "dofek-server/router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { trpc } from "../lib/trpc.ts";

const PAGE_SIZE = 20;

type ClinicalRecordSummary = AppRouterOutputs["clinicalRecords"]["list"]["records"][number];

interface ClinicalRecordGroup {
  key: string;
  records: ClinicalRecordSummary[];
  sourceLabel: string;
  typeLabel: string;
}

function groupRecords(records: ClinicalRecordSummary[]): ClinicalRecordGroup[] {
  const groups = new Map<string, ClinicalRecordGroup>();
  for (const record of records) {
    const key = JSON.stringify([record.typeLabel, record.sourceLabel]);
    const group = groups.get(key);
    if (group) {
      group.records.push(record);
    } else {
      groups.set(key, {
        key,
        records: [record],
        sourceLabel: record.sourceLabel,
        typeLabel: record.typeLabel,
      });
    }
  }
  return [...groups.values()];
}

export function ClinicalRecordsPage() {
  const [offset, setOffset] = useState(0);
  const recordsQuery = trpc.clinicalRecords.list.useQuery({ limit: PAGE_SIZE, offset });
  const records = recordsQuery.data?.records;

  return (
    <PageLayout
      title="Clinical Records"
      subtitle="Read-only records synced explicitly from Apple Health"
    >
      {recordsQuery.isLoading && records === undefined ? (
        <QueryStatePanel
          variant="loading"
          contextLabel="Clinical records"
          message="Loading clinical records."
        />
      ) : recordsQuery.error && records === undefined ? (
        <QueryStatePanel
          error={recordsQuery.error}
          title="Clinical records are unavailable"
          onRetry={() => void recordsQuery.refetch()}
          retrying={recordsQuery.isFetching}
        />
      ) : recordsQuery.error && records?.length === 0 ? (
        <QueryStatePanel
          error={recordsQuery.error}
          title="Clinical records refresh failed"
          onRetry={() => void recordsQuery.refetch()}
          retrying={recordsQuery.isFetching}
        />
      ) : records?.length === 0 ? (
        <QueryStatePanel
          variant="empty"
          title="No clinical records"
          message="No clinical records have been synced yet."
        />
      ) : records ? (
        <div className="space-y-5">
          {recordsQuery.error ? (
            <QueryStatePanel
              error={recordsQuery.error}
              title="Clinical records refresh failed"
              height={96}
              onRetry={() => void recordsQuery.refetch()}
              retrying={recordsQuery.isFetching}
            />
          ) : null}

          {groupRecords(records).map((group) => (
            <section key={group.key} className="space-y-2">
              <div>
                <h2 className="text-sm font-semibold text-foreground">{group.typeLabel}</h2>
                <p className="text-xs text-subtle">{group.sourceLabel}</p>
              </div>
              <ul className="card divide-y divide-border">
                {group.records.map((record) => (
                  <li key={record.id}>
                    <Link
                      to="/clinical-records/$id"
                      params={{ id: record.id }}
                      aria-label={record.displayName}
                      className="block px-4 py-3 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="block text-sm font-medium text-foreground">
                        {record.displayName}
                      </span>
                      <span className="mt-1 block text-xs text-subtle">{record.dateLabel}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <nav aria-label="Clinical record pages" className="flex items-center justify-between">
            <button
              type="button"
              className="rounded bg-accent/10 px-3 py-1.5 text-xs text-foreground disabled:opacity-50"
              disabled={offset === 0}
              onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              type="button"
              className="rounded bg-accent/10 px-3 py-1.5 text-xs text-foreground disabled:opacity-50"
              disabled={recordsQuery.data?.nextOffset === null}
              onClick={() => {
                if (recordsQuery.data?.nextOffset != null) {
                  setOffset(recordsQuery.data.nextOffset);
                }
              }}
            >
              Next
            </button>
          </nav>
        </div>
      ) : (
        <QueryStatePanel variant="empty" message="No clinical records have been synced yet." />
      )}
    </PageLayout>
  );
}

export function ClinicalRecordDetailPage() {
  const { id } = useParams({ from: "/clinical-records/$id" });
  const recordQuery = trpc.clinicalRecords.detail.useQuery({ id });
  const record = recordQuery.data;

  return (
    <PageLayout>
      {recordQuery.isLoading && record === undefined ? (
        <QueryStatePanel
          variant="loading"
          contextLabel="Clinical record"
          message="Loading clinical record."
        />
      ) : recordQuery.error && record === undefined ? (
        <QueryStatePanel
          error={recordQuery.error}
          title="Clinical record is unavailable"
          onRetry={() => void recordQuery.refetch()}
          retrying={recordQuery.isFetching}
        />
      ) : record ? (
        <div className="space-y-5">
          <div className="flex items-center gap-2 text-xs text-subtle">
            <Link to="/clinical-records" className="hover:text-foreground">
              Clinical Records
            </Link>
            <span aria-hidden="true">/</span>
            <span className="text-foreground">{record.displayName}</span>
          </div>

          {recordQuery.error ? (
            <QueryStatePanel
              error={recordQuery.error}
              title="Clinical record refresh failed"
              height={96}
              onRetry={() => void recordQuery.refetch()}
              retrying={recordQuery.isFetching}
            />
          ) : null}

          <section className="card space-y-3 p-5">
            <h1 className="text-xl font-semibold text-foreground">{record.displayName}</h1>
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-subtle">Type</dt>
                <dd className="mt-1 text-foreground">{record.typeLabel}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-subtle">Source</dt>
                <dd className="mt-1 text-foreground">{record.sourceLabel}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-subtle">Date</dt>
                <dd className="mt-1 text-foreground">{record.dateLabel}</dd>
              </div>
            </dl>
          </section>

          <section className="card space-y-3 p-5">
            <div>
              <h2 className="text-sm font-semibold text-foreground">FHIR resource</h2>
              <p className="mt-1 text-xs text-subtle">FHIR version {record.fhirVersion}</p>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-surface-secondary p-4 text-xs text-foreground">
              {JSON.stringify(record.fhir, null, 2)}
            </pre>
          </section>
        </div>
      ) : (
        <QueryStatePanel variant="empty" message="Clinical record not found." />
      )}
    </PageLayout>
  );
}

import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { type ReactNode, useMemo, useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { useAuth } from "../lib/auth-context.tsx";
import { trpc } from "../lib/trpc.ts";

type Tab =
  | "overview"
  | "users"
  | "syncLogs"
  | "syncHealth"
  | "activities"
  | "sleep"
  | "sessions"
  | "food"
  | "body"
  | "dailyMetrics"
  | "tokens"
  | "trainingExport";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "syncHealth", label: "Sync Health" },
  { id: "syncLogs", label: "Sync Logs" },
  { id: "activities", label: "Activities" },
  { id: "sleep", label: "Sleep" },
  { id: "food", label: "Food" },
  { id: "body", label: "Body" },
  { id: "dailyMetrics", label: "Daily Metrics" },
  { id: "sessions", label: "Sessions" },
  { id: "tokens", label: "OAuth Tokens" },
  { id: "trainingExport", label: "Training Export" },
];

export function AdminPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  if (!user?.isAdmin) {
    return (
      <PageLayout title="Admin">
        <div className="card p-8 text-center">
          <p className="text-muted">You do not have admin access.</p>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Admin">
      <nav className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-2 text-xs rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === tab.id
                ? "bg-accent/15 text-foreground"
                : "text-subtle hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "overview" && <OverviewTab />}
      {activeTab === "users" && <UsersTab />}
      {activeTab === "syncHealth" && <SyncHealthTab />}
      {activeTab === "syncLogs" && <SyncLogsTab />}
      {activeTab === "activities" && <ActivitiesTab />}
      {activeTab === "sleep" && <SleepTab />}
      {activeTab === "food" && <FoodTab />}
      {activeTab === "body" && <BodyTab />}
      {activeTab === "dailyMetrics" && <DailyMetricsTab />}
      {activeTab === "sessions" && <SessionsTab />}
      {activeTab === "tokens" && <TokensTab />}
      {activeTab === "trainingExport" && <TrainingExportTab />}
    </PageLayout>
  );
}

// ── Generic data table component ──

function DataTable<TData>({
  columns,
  data,
}: {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
}) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} className="border-b border-border">
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  className="text-left px-3 py-2 text-muted uppercase tracking-wider font-medium"
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-border/50 hover:bg-card-hover transition-colors"
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-3 py-2 text-foreground">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Pagination controls ──

function Pagination({
  offset,
  limit,
  total,
  onPageChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onPageChange: (newOffset: number) => void;
}) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs text-muted">
      <span>
        {total.toLocaleString()} total — page {currentPage} of {totalPages}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onPageChange(Math.max(0, offset - limit))}
          className="px-2 py-1 rounded border border-border disabled:opacity-30 hover:bg-card-hover transition-colors cursor-pointer disabled:cursor-default"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={offset + limit >= total}
          onClick={() => onPageChange(offset + limit)}
          className="px-2 py-1 rounded border border-border disabled:opacity-30 hover:bg-card-hover transition-colors cursor-pointer disabled:cursor-default"
        >
          Next
        </button>
      </div>
    </div>
  );
}

// ── Card wrapper ──

function AdminCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">{title}</h3>
      <div className="card p-0 overflow-hidden">{children}</div>
    </section>
  );
}

// ── Loading/Error states ──

function LoadingState() {
  return (
    <div className="card p-8 text-center">
      <div className="w-5 h-5 border-2 border-border-strong border-t-accent rounded-full animate-spin mx-auto" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return <div className="card p-4 text-center text-red-400 text-xs">{message}</div>;
}

// ── Helper to format timestamps ──
function formatTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) return "\u2014";
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ShortId({ id }: { id: string }) {
  return (
    <span title={id} className="font-mono text-dim">
      {id.slice(0, 8)}
    </span>
  );
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "\u2014";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// ── Tab: Overview ──

function OverviewTab() {
  const { data, isLoading, error } = trpc.admin.overview.useQuery();
  const refreshViews = trpc.admin.refreshViews.useMutation();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <div className="space-y-6">
      <AdminCard title="Table Row Counts">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-px bg-border/30">
          {data?.map((item) => (
            <div key={item.table_name} className="bg-card p-3">
              <div className="text-lg font-semibold text-foreground">
                {item.row_count.toLocaleString()}
              </div>
              <div className="text-xs text-muted mt-0.5">{item.table_name}</div>
            </div>
          ))}
        </div>
      </AdminCard>

      <AdminCard title="Materialized Views">
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={refreshViews.isPending}
              onClick={() => refreshViews.mutate()}
              className="px-3 py-1.5 rounded text-xs font-medium bg-accent/15 text-foreground hover:bg-accent/25 disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-default"
            >
              {refreshViews.isPending ? "Refreshing..." : "Refresh All Views"}
            </button>
            {refreshViews.isSuccess && (
              <span
                className={`text-xs ${refreshViews.data.failed.length > 0 ? "text-amber-400" : "text-green-400"}`}
              >
                Refreshed {refreshViews.data.refreshed.length} views
                {refreshViews.data.failed.length > 0 &&
                  `, ${refreshViews.data.failed.length} failed`}
              </span>
            )}
            {refreshViews.isError && (
              <span className="text-xs text-red-400">{refreshViews.error.message}</span>
            )}
          </div>
          {refreshViews.isSuccess && (
            <div className="flex flex-wrap gap-1.5">
              {refreshViews.data.refreshed.map((view) => (
                <span
                  key={view}
                  className="px-2 py-0.5 rounded bg-green-500/10 text-green-400 text-xs font-mono"
                >
                  {view}
                </span>
              ))}
              {refreshViews.data.failed.map(({ view, error }) => (
                <span
                  key={view}
                  title={error}
                  className="px-2 py-0.5 rounded bg-red-500/10 text-red-400 text-xs font-mono"
                >
                  {view}
                </span>
              ))}
            </div>
          )}
        </div>
      </AdminCard>
    </div>
  );
}

// ── Tab: Users ──

function UsersTab() {
  const { data, isLoading, error } = trpc.admin.users.useQuery();
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const trpcUtils = trpc.useUtils();
  const setAdminMutation = trpc.admin.setAdmin.useMutation({
    onSuccess: () => trpcUtils.admin.users.invalidate(),
  });

  const columns = useMemo<ColumnDef<NonNullable<typeof data>[number], unknown>[]>(
    () => [
      { id: "id", header: "ID", cell: ({ row }) => <ShortId id={row.original.id} /> },
      { accessorKey: "name", header: "Name" },
      { id: "email", header: "Email", cell: ({ row }) => row.original.email ?? "\u2014" },
      {
        id: "is_admin",
        header: "Admin",
        cell: ({ row }) => {
          const userId = row.original.id;
          const admin = row.original.is_admin;
          return (
            <button
              type="button"
              onClick={() => setAdminMutation.mutate({ userId, isAdmin: !admin })}
              className={`px-2 py-0.5 rounded text-xs cursor-pointer ${admin ? "bg-green-500/20 text-green-400" : "bg-zinc-700/50 text-muted hover:bg-zinc-600/50"}`}
            >
              {admin ? "Yes" : "No"}
            </button>
          );
        },
      },
      {
        id: "created_at",
        header: "Created",
        cell: ({ row }) => formatTimestamp(row.original.created_at),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() =>
              setExpandedUserId(expandedUserId === row.original.id ? null : row.original.id)
            }
            className="text-accent hover:underline cursor-pointer"
          >
            {expandedUserId === row.original.id ? "Hide" : "Details"}
          </button>
        ),
      },
    ],
    [expandedUserId, setAdminMutation],
  );

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <div className="space-y-4">
      <AdminCard title="All Users">
        <DataTable columns={columns} data={data ?? []} />
      </AdminCard>
      {expandedUserId && <UserDetailPanel userId={expandedUserId} />}
    </div>
  );
}

function UserDetailPanel({ userId }: { userId: string }) {
  const { data, isLoading, error } = trpc.admin.userDetail.useQuery({ userId });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <AdminCard title="Auth Accounts">
        {data?.accounts.length === 0 ? (
          <p className="p-3 text-xs text-muted">No accounts</p>
        ) : (
          <div className="divide-y divide-border/50">
            {data?.accounts.map((account) => (
              <div key={account.id} className="p-3 text-xs space-y-1">
                <div className="font-medium text-foreground">{account.auth_provider}</div>
                <div className="text-muted">{account.email ?? account.provider_account_id}</div>
                <div className="text-dim">{formatTimestamp(account.created_at)}</div>
              </div>
            ))}
          </div>
        )}
      </AdminCard>
      <AdminCard title="Data Providers">
        {data?.providers.length === 0 ? (
          <p className="p-3 text-xs text-muted">No providers</p>
        ) : (
          <div className="divide-y divide-border/50">
            {data?.providers.map((provider) => (
              <div key={provider.id} className="p-3 text-xs space-y-1">
                <div className="font-medium text-foreground">{provider.name}</div>
                <div className="text-muted font-mono">{provider.id}</div>
                <div className="text-dim">{formatTimestamp(provider.created_at)}</div>
              </div>
            ))}
          </div>
        )}
      </AdminCard>
      <AdminCard title="Recent Sessions">
        {data?.sessions.length === 0 ? (
          <p className="p-3 text-xs text-muted">No sessions</p>
        ) : (
          <div className="divide-y divide-border/50">
            {data?.sessions.map((session) => (
              <div key={session.id} className="p-3 text-xs space-y-1">
                <div className="font-mono text-muted">{session.id.slice(0, 16)}...</div>
                <div className="text-dim">
                  Created: {formatTimestamp(session.created_at)} — Expires:{" "}
                  {formatTimestamp(session.expires_at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </AdminCard>
    </div>
  );
}

// ── Tab: Sync Health ──

function SyncHealthTab() {
  const { data, isLoading, error } = trpc.admin.syncHealth.useQuery();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const columns: ColumnDef<NonNullable<typeof data>[number], unknown>[] = [
    { accessorKey: "provider_id", header: "Provider" },
    { id: "total", header: "Total (7d)", cell: ({ row }) => row.original.total.toLocaleString() },
    {
      id: "succeeded",
      header: "Succeeded",
      cell: ({ row }) => (
        <span className="text-green-400">{row.original.succeeded.toLocaleString()}</span>
      ),
    },
    {
      id: "failed",
      header: "Failed",
      cell: ({ row }) => {
        const count = row.original.failed;
        return (
          <span className={count > 0 ? "text-red-400 font-medium" : "text-muted"}>
            {count.toLocaleString()}
          </span>
        );
      },
    },
    {
      id: "rate",
      header: "Success Rate",
      cell: ({ row }) => {
        const total = row.original.total;
        const succeeded = row.original.succeeded;
        const rate = total > 0 ? Math.round((succeeded / total) * 100) : 0;
        return <span className={rate < 90 ? "text-amber-400" : "text-green-400"}>{rate}%</span>;
      },
    },
    {
      id: "last_sync",
      header: "Last Sync",
      cell: ({ row }) => formatTimestamp(row.original.last_sync),
    },
  ];

  return (
    <AdminCard title="Sync Health (Last 7 Days)">
      <DataTable columns={columns} data={data ?? []} />
    </AdminCard>
  );
}

// ── Tab: Sync Logs ──

function SyncLogsTab() {
  const [pagination, setPagination] = useState({ offset: 0, limit: 50 });
  const { data, isLoading, error } = trpc.admin.syncLogs.useQuery(pagination);

  const columns: ColumnDef<NonNullable<typeof data>["rows"][number], unknown>[] = [
    { accessorKey: "provider_id", header: "Provider" },
    { id: "user_name", header: "User", cell: ({ row }) => row.original.user_name ?? "\u2014" },
    { accessorKey: "data_type", header: "Data Type" },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => {
        const status = row.original.status;
        const color =
          status === "success"
            ? "text-green-400"
            : status === "error"
              ? "text-red-400"
              : "text-amber-400";
        return <span className={color}>{status}</span>;
      },
    },
    {
      id: "record_count",
      header: "Records",
      cell: ({ row }) => {
        const value = row.original.record_count;
        return value !== null ? value.toLocaleString() : "\u2014";
      },
    },
    {
      id: "error_message",
      header: "Error",
      cell: ({ row }) => {
        const message = row.original.error_message;
        if (!message) return "\u2014";
        return (
          <span className="text-red-400 max-w-xs truncate block" title={message}>
            {message}
          </span>
        );
      },
    },
    {
      id: "synced_at",
      header: "Synced",
      cell: ({ row }) => formatTimestamp(row.original.synced_at),
    },
  ];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <AdminCard title="Sync Logs">
      <DataTable columns={columns} data={data?.rows ?? []} />
      <Pagination
        offset={pagination.offset}
        limit={pagination.limit}
        total={data?.total ?? 0}
        onPageChange={(newOffset) => setPagination((prev) => ({ ...prev, offset: newOffset }))}
      />
    </AdminCard>
  );
}

// ── Tab: Activities ──

function ActivitiesTab() {
  const [pagination, setPagination] = useState({ offset: 0, limit: 50 });
  const { data, isLoading, error } = trpc.admin.activities.useQuery(pagination);

  const columns: ColumnDef<NonNullable<typeof data>["rows"][number], unknown>[] = [
    { id: "id", header: "ID", cell: ({ row }) => <ShortId id={row.original.id} /> },
    { id: "user_name", header: "User", cell: ({ row }) => row.original.user_name ?? "\u2014" },
    { accessorKey: "provider_id", header: "Provider" },
    {
      id: "activity_type",
      header: "Type",
      cell: ({ row }) => row.original.activity_type ?? "\u2014",
    },
    {
      id: "name",
      header: "Name",
      cell: ({ row }) => {
        const name = row.original.name;
        if (!name) return "\u2014";
        return (
          <span className="max-w-xs truncate block" title={name}>
            {name}
          </span>
        );
      },
    },
    {
      id: "duration",
      header: "Duration",
      cell: ({ row }) => formatDuration(row.original.duration_seconds),
    },
    {
      id: "started_at",
      header: "Started",
      cell: ({ row }) => formatTimestamp(row.original.started_at),
    },
    {
      id: "source_name",
      header: "Source",
      cell: ({ row }) => row.original.source_name ?? "\u2014",
    },
  ];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <AdminCard title="Activities">
      <DataTable columns={columns} data={data?.rows ?? []} />
      <Pagination
        offset={pagination.offset}
        limit={pagination.limit}
        total={data?.total ?? 0}
        onPageChange={(newOffset) => setPagination((prev) => ({ ...prev, offset: newOffset }))}
      />
    </AdminCard>
  );
}

// ── Tab: Sleep ──

function SleepTab() {
  const [pagination, setPagination] = useState({ offset: 0, limit: 50 });
  const { data, isLoading, error } = trpc.admin.sleepSessions.useQuery(pagination);

  const columns: ColumnDef<NonNullable<typeof data>["rows"][number], unknown>[] = [
    { id: "id", header: "ID", cell: ({ row }) => <ShortId id={row.original.id} /> },
    { id: "user_name", header: "User", cell: ({ row }) => row.original.user_name ?? "\u2014" },
    { accessorKey: "provider_id", header: "Provider" },
    { id: "sleep_type", header: "Type", cell: ({ row }) => row.original.sleep_type ?? "\u2014" },
    {
      id: "started_at",
      header: "Start",
      cell: ({ row }) => formatTimestamp(row.original.started_at),
    },
    { id: "ended_at", header: "End", cell: ({ row }) => formatTimestamp(row.original.ended_at) },
    {
      id: "source_name",
      header: "Source",
      cell: ({ row }) => row.original.source_name ?? "\u2014",
    },
  ];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <AdminCard title="Sleep Sessions">
      <DataTable columns={columns} data={data?.rows ?? []} />
      <Pagination
        offset={pagination.offset}
        limit={pagination.limit}
        total={data?.total ?? 0}
        onPageChange={(newOffset) => setPagination((prev) => ({ ...prev, offset: newOffset }))}
      />
    </AdminCard>
  );
}

// ── Tab: Food ──

function FoodTab() {
  const [pagination, setPagination] = useState({ offset: 0, limit: 50 });
  const { data, isLoading, error } = trpc.admin.foodEntries.useQuery(pagination);

  const columns: ColumnDef<NonNullable<typeof data>["rows"][number], unknown>[] = [
    { id: "id", header: "ID", cell: ({ row }) => <ShortId id={row.original.id} /> },
    { id: "user_name", header: "User", cell: ({ row }) => row.original.user_name ?? "\u2014" },
    { accessorKey: "food_name", header: "Food" },
    {
      id: "calories",
      header: "Calories",
      cell: ({ row }) => {
        const value = row.original.calories;
        return value !== null ? Math.round(value).toLocaleString() : "\u2014";
      },
    },
    {
      id: "protein_g",
      header: "Protein (g)",
      cell: ({ row }) => {
        const value = row.original.protein_g;
        return value !== null ? Math.round(value).toLocaleString() : "\u2014";
      },
    },
    { id: "meal", header: "Meal", cell: ({ row }) => row.original.meal ?? "\u2014" },
    {
      id: "logged_at",
      header: "Logged At",
      cell: ({ row }) => formatTimestamp(row.original.logged_at),
    },
    { accessorKey: "provider_id", header: "Provider" },
  ];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <AdminCard title="Food Entries">
      <DataTable columns={columns} data={data?.rows ?? []} />
      <Pagination
        offset={pagination.offset}
        limit={pagination.limit}
        total={data?.total ?? 0}
        onPageChange={(newOffset) => setPagination((prev) => ({ ...prev, offset: newOffset }))}
      />
    </AdminCard>
  );
}

// ── Tab: Body ──

function BodyTab() {
  const [pagination, setPagination] = useState({ offset: 0, limit: 50 });
  const { data, isLoading, error } = trpc.admin.bodyMeasurements.useQuery(pagination);

  const columns: ColumnDef<NonNullable<typeof data>["rows"][number], unknown>[] = [
    { id: "id", header: "ID", cell: ({ row }) => <ShortId id={row.original.id} /> },
    { id: "user_name", header: "User", cell: ({ row }) => row.original.user_name ?? "\u2014" },
    {
      id: "provider_id",
      header: "Provider",
      cell: ({ row }) => row.original.provider_id ?? "\u2014",
    },
    {
      id: "recorded_at",
      header: "Recorded At",
      cell: ({ row }) => formatTimestamp(row.original.recorded_at),
    },
    {
      id: "source_name",
      header: "Source",
      cell: ({ row }) => row.original.source_name ?? "\u2014",
    },
  ];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <AdminCard title="Body Measurements">
      <DataTable columns={columns} data={data?.rows ?? []} />
      <Pagination
        offset={pagination.offset}
        limit={pagination.limit}
        total={data?.total ?? 0}
        onPageChange={(newOffset) => setPagination((prev) => ({ ...prev, offset: newOffset }))}
      />
    </AdminCard>
  );
}

// ── Tab: Daily Metrics ──

function DailyMetricsTab() {
  const [pagination, setPagination] = useState({ offset: 0, limit: 50 });
  const { data, isLoading, error } = trpc.admin.dailyMetrics.useQuery(pagination);

  const columns: ColumnDef<NonNullable<typeof data>["rows"][number], unknown>[] = [
    { id: "id", header: "ID", cell: ({ row }) => <ShortId id={row.original.id} /> },
    { id: "user_name", header: "User", cell: ({ row }) => row.original.user_name ?? "\u2014" },
    { accessorKey: "date", header: "Date" },
    { accessorKey: "provider_id", header: "Provider" },
    {
      id: "source_name",
      header: "Source",
      cell: ({ row }) => row.original.source_name ?? "\u2014",
    },
  ];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <AdminCard title="Daily Metrics">
      <DataTable columns={columns} data={data?.rows ?? []} />
      <Pagination
        offset={pagination.offset}
        limit={pagination.limit}
        total={data?.total ?? 0}
        onPageChange={(newOffset) => setPagination((prev) => ({ ...prev, offset: newOffset }))}
      />
    </AdminCard>
  );
}

// ── Tab: Sessions ──

function SessionsTab() {
  const [pagination, setPagination] = useState({ offset: 0, limit: 50 });
  const { data, isLoading, error } = trpc.admin.sessions.useQuery(pagination);
  const trpcUtils = trpc.useUtils();
  const deleteMutation = trpc.admin.deleteSession.useMutation({
    onSuccess: () => trpcUtils.admin.sessions.invalidate(),
  });

  const columns: ColumnDef<NonNullable<typeof data>["rows"][number], unknown>[] = [
    {
      id: "id",
      header: "Session ID",
      cell: ({ row }) => (
        <span className="font-mono text-dim" title={row.original.id}>
          {row.original.id.slice(0, 16)}...
        </span>
      ),
    },
    { id: "user_name", header: "User", cell: ({ row }) => row.original.user_name ?? "\u2014" },
    {
      id: "created_at",
      header: "Created",
      cell: ({ row }) => formatTimestamp(row.original.created_at),
    },
    {
      id: "expires_at",
      header: "Expires",
      cell: ({ row }) => formatTimestamp(row.original.expires_at),
    },
    {
      id: "is_expired",
      header: "Status",
      cell: ({ row }) => {
        const expired = row.original.is_expired;
        return (
          <span className={expired ? "text-red-400" : "text-green-400"}>
            {expired ? "Expired" : "Active"}
          </span>
        );
      },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <button
          type="button"
          onClick={() => deleteMutation.mutate({ sessionId: row.original.id })}
          className="text-red-400 hover:underline text-xs cursor-pointer"
        >
          Revoke
        </button>
      ),
    },
  ];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <AdminCard title="Sessions">
      <DataTable columns={columns} data={data?.rows ?? []} />
      <Pagination
        offset={pagination.offset}
        limit={pagination.limit}
        total={data?.total ?? 0}
        onPageChange={(newOffset) => setPagination((prev) => ({ ...prev, offset: newOffset }))}
      />
    </AdminCard>
  );
}

// ── Tab: OAuth Tokens ──

function TokensTab() {
  const { data, isLoading, error } = trpc.admin.oauthTokens.useQuery();

  const columns: ColumnDef<NonNullable<typeof data>[number], unknown>[] = [
    { id: "user_name", header: "User", cell: ({ row }) => row.original.user_name ?? "\u2014" },
    { accessorKey: "provider_id", header: "Provider" },
    {
      id: "scopes",
      header: "Scopes",
      cell: ({ row }) => {
        const scopes = row.original.scopes;
        if (!scopes) return "\u2014";
        return (
          <span className="max-w-xs truncate block" title={scopes}>
            {scopes}
          </span>
        );
      },
    },
    {
      id: "expires_at",
      header: "Expires",
      cell: ({ row }) => {
        const expiresAt = row.original.expires_at;
        if (!expiresAt) return "\u2014";
        const expired = new Date(expiresAt) < new Date();
        return (
          <span className={expired ? "text-red-400" : "text-foreground"}>
            {formatTimestamp(expiresAt)}
          </span>
        );
      },
    },
    {
      id: "updated_at",
      header: "Updated",
      cell: ({ row }) => formatTimestamp(row.original.updated_at),
    },
  ];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <AdminCard title="OAuth Tokens (No Secrets)">
      <DataTable columns={columns} data={data ?? []} />
    </AdminCard>
  );
}

function TrainingExportTab() {
  const { data: status, isLoading, error } = trpc.admin.trainingExportStatus.useQuery();
  const trpcUtils = trpc.useUtils();
  const triggerExport = trpc.admin.triggerTrainingExport.useMutation({
    onSuccess: () => {
      trpcUtils.admin.trainingExportStatus.invalidate();
    },
  });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <AdminCard title="Training Data Export">
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            disabled={triggerExport.isPending}
            onClick={() => triggerExport.mutate({})}
          >
            {triggerExport.isPending ? "Triggering..." : "Trigger Export"}
          </button>
          {triggerExport.isSuccess && (
            <span className="text-sm text-green-600">
              Export job queued (ID: {triggerExport.data.jobId})
            </span>
          )}
          {triggerExport.isError && (
            <span className="text-sm text-red-600">{triggerExport.error.message}</span>
          )}
        </div>

        <h3 className="text-sm font-medium text-gray-700">Watermarks</h3>
        {status?.watermarks.length === 0 ? (
          <p className="text-sm text-gray-500">No exports yet</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="pb-2 pr-4">Table</th>
                <th className="pb-2 pr-4">Last Exported</th>
                <th className="pb-2 pr-4">Rows</th>
                <th className="pb-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {status?.watermarks.map((watermark) => (
                <tr key={watermark.table_name} className="border-b">
                  <td className="py-2 pr-4 font-mono">{watermark.table_name}</td>
                  <td className="py-2 pr-4">{watermark.last_exported_at}</td>
                  <td className="py-2 pr-4">{watermark.row_count.toLocaleString()}</td>
                  <td className="py-2">{watermark.updated_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AdminCard>
  );
}

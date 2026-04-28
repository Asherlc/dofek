import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { useAuth } from "../lib/auth-context.tsx";
import { trpc } from "../lib/trpc.ts";

function formatTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DetailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-3">{title}</h3>
      <div className="card p-4">{children}</div>
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/50 py-2 last:border-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-right text-xs text-foreground">{children}</dd>
    </div>
  );
}

function statusLabel(enabled: boolean): string {
  return enabled ? "Yes" : "No";
}

function accessLabel(
  access:
    | { kind: "full"; paid: true; reason: "paid_grant" | "stripe_subscription" }
    | {
        kind: "limited";
        paid: false;
        reason: "free_signup_week";
        startDate: string;
        endDateExclusive: string;
      },
): string {
  if (access.kind === "limited") {
    return `Limited to ${access.startDate} through ${access.endDateExclusive}`;
  }
  return access.reason === "stripe_subscription"
    ? "Full access from Stripe subscription"
    : "Full access from local grant";
}

type AdminUserAccess =
  | { kind: "full"; paid: true; reason: "paid_grant" | "stripe_subscription" }
  | {
      kind: "limited";
      paid: false;
      reason: "free_signup_week";
      startDate: string;
      endDateExclusive: string;
    };

export interface AdminUserDetail {
  profile: {
    id: string;
    name: string;
    email: string | null;
    birth_date: string | null;
    is_admin: boolean;
    created_at: string;
    updated_at: string;
  };
  flags: {
    providerGuideDismissed: boolean;
  };
  billing: {
    user_id: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    stripe_subscription_status: string | null;
    stripe_current_period_end: string | null;
    paid_grant_reason: string | null;
    created_at: string;
    updated_at: string;
  } | null;
  access: AdminUserAccess;
  stripeLinks: {
    customer: string | null;
    subscription: string | null;
  };
  accounts: {
    id: string;
    auth_provider: string;
    provider_account_id: string;
    email: string | null;
    name: string | null;
    created_at: string;
  }[];
  providers: {
    id: string;
    name: string;
    created_at: string;
  }[];
  sessions: {
    id: string;
    created_at: string;
    expires_at: string;
  }[];
}

export interface AdminUserDetailViewProps {
  detail: AdminUserDetail | null | undefined;
  errorMessage?: string;
  isAdminViewer: boolean;
  isLoading: boolean;
  onToggleAdmin?: () => void;
  onTogglePaidGrant?: () => void;
  onToggleProviderGuideDismissed?: () => void;
  setAdminPending?: boolean;
  setPaidGrantPending?: boolean;
  setProviderGuideDismissedPending?: boolean;
}

export function AdminUserDetailPage() {
  const { user } = useAuth();
  if (!user?.isAdmin) {
    return <AdminUserDetailView detail={undefined} isAdminViewer={false} isLoading={false} />;
  }

  return <AdminUserDetailContent />;
}

function AdminUserDetailContent() {
  const { userId } = useParams({ from: "/admin/users/$userId" });
  const trpcUtils = trpc.useUtils();
  const detailQuery = trpc.admin.userDetail.useQuery({ userId });
  const refreshDetail = () => trpcUtils.admin.userDetail.invalidate({ userId });
  const setAdminMutation = trpc.admin.setAdmin.useMutation({
    onSuccess: async () => {
      await Promise.all([refreshDetail(), trpcUtils.admin.users.invalidate()]);
    },
  });
  const setProviderGuideDismissedMutation = trpc.admin.setProviderGuideDismissed.useMutation({
    onSuccess: refreshDetail,
  });
  const setPaidGrantMutation = trpc.admin.setPaidGrant.useMutation({
    onSuccess: refreshDetail,
  });

  return (
    <AdminUserDetailView
      detail={detailQuery.data}
      errorMessage={detailQuery.error?.message}
      isAdminViewer={true}
      isLoading={detailQuery.isLoading}
      onToggleAdmin={() => {
        if (!detailQuery.data) return;
        setAdminMutation.mutate({
          userId: detailQuery.data.profile.id,
          isAdmin: !detailQuery.data.profile.is_admin,
        });
      }}
      onTogglePaidGrant={() => {
        if (!detailQuery.data) return;
        const hasPaidGrant =
          detailQuery.data.billing?.paid_grant_reason !== null && detailQuery.data.billing !== null;
        setPaidGrantMutation.mutate({
          userId: detailQuery.data.profile.id,
          enabled: !hasPaidGrant,
        });
      }}
      onToggleProviderGuideDismissed={() => {
        if (!detailQuery.data) return;
        setProviderGuideDismissedMutation.mutate({
          userId: detailQuery.data.profile.id,
          dismissed: !detailQuery.data.flags.providerGuideDismissed,
        });
      }}
      setAdminPending={setAdminMutation.isPending}
      setPaidGrantPending={setPaidGrantMutation.isPending}
      setProviderGuideDismissedPending={setProviderGuideDismissedMutation.isPending}
    />
  );
}

export function AdminUserDetailView({
  detail,
  errorMessage,
  isAdminViewer,
  isLoading,
  onToggleAdmin,
  onTogglePaidGrant,
  onToggleProviderGuideDismissed,
  setAdminPending = false,
  setPaidGrantPending = false,
  setProviderGuideDismissedPending = false,
}: AdminUserDetailViewProps) {
  if (!isAdminViewer) {
    return (
      <PageLayout title="Admin User">
        <div className="card p-8 text-center">
          <p className="text-muted">You do not have admin access.</p>
        </div>
      </PageLayout>
    );
  }

  if (isLoading) {
    return (
      <PageLayout title="Admin User">
        <div className="card p-8 text-center">
          <div className="w-5 h-5 border-2 border-border-strong border-t-accent rounded-full animate-spin mx-auto" />
        </div>
      </PageLayout>
    );
  }

  if (errorMessage) {
    return (
      <PageLayout title="Admin User">
        <div className="card p-4 text-center text-red-400 text-xs">{errorMessage}</div>
      </PageLayout>
    );
  }

  if (!detail) {
    return (
      <PageLayout title="Admin User">
        <div className="card p-4 text-center text-muted text-xs">User not found.</div>
      </PageLayout>
    );
  }

  const hasPaidGrant = detail.billing?.paid_grant_reason !== null && detail.billing !== null;

  return (
    <PageLayout title={detail.profile.name}>
      <div className="space-y-4">
        <Link to="/admin" className="text-xs text-accent hover:underline">
          Back to admin
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <DetailCard title="Profile">
            <dl>
              <DetailRow label="User ID">
                <span className="font-mono text-dim">{detail.profile.id}</span>
              </DetailRow>
              <DetailRow label="Name">{detail.profile.name}</DetailRow>
              <DetailRow label="Email">{detail.profile.email ?? "—"}</DetailRow>
              <DetailRow label="Birth date">{detail.profile.birth_date ?? "—"}</DetailRow>
              <DetailRow label="Created">{formatTimestamp(detail.profile.created_at)}</DetailRow>
              <DetailRow label="Updated">{formatTimestamp(detail.profile.updated_at)}</DetailRow>
            </dl>
          </DetailCard>

          <DetailCard title="Flags">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm text-foreground">Admin</div>
                  <div className="text-xs text-muted">{statusLabel(detail.profile.is_admin)}</div>
                </div>
                <button
                  type="button"
                  disabled={setAdminPending}
                  onClick={onToggleAdmin}
                  className="px-3 py-1.5 text-xs rounded border border-border-strong text-foreground hover:bg-card-hover disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-default"
                >
                  {detail.profile.is_admin ? "Remove admin" : "Make admin"}
                </button>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm text-foreground">Provider guide banner</div>
                  <div className="text-xs text-muted">
                    {detail.flags.providerGuideDismissed ? "Dismissed" : "Visible"}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={setProviderGuideDismissedPending}
                  onClick={onToggleProviderGuideDismissed}
                  className="px-3 py-1.5 text-xs rounded border border-border-strong text-foreground hover:bg-card-hover disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-default"
                >
                  {detail.flags.providerGuideDismissed
                    ? "Mark banner visible"
                    : "Mark banner dismissed"}
                </button>
              </div>
            </div>
          </DetailCard>
        </div>

        <DetailCard title="Billing">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <dl>
              <DetailRow label="Access">{accessLabel(detail.access)}</DetailRow>
              <DetailRow label="Local paid grant">
                {detail.billing?.paid_grant_reason ?? "—"}
              </DetailRow>
              <DetailRow label="Stripe customer">
                {detail.billing?.stripe_customer_id ?? "—"}
              </DetailRow>
              <DetailRow label="Stripe subscription">
                {detail.billing?.stripe_subscription_id ?? "—"}
              </DetailRow>
              <DetailRow label="Stripe status">
                {detail.billing?.stripe_subscription_status ?? "—"}
              </DetailRow>
              <DetailRow label="Current period end">
                {formatTimestamp(detail.billing?.stripe_current_period_end)}
              </DetailRow>
            </dl>

            <div className="space-y-3">
              {detail.billing?.stripe_subscription_status ? (
                <p className="text-xs text-muted">
                  Stripe subscription status: {detail.billing.stripe_subscription_status}
                </p>
              ) : null}
              <button
                type="button"
                disabled={setPaidGrantPending}
                onClick={onTogglePaidGrant}
                className="px-3 py-1.5 text-xs rounded border border-border-strong text-foreground hover:bg-card-hover disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-default"
              >
                {hasPaidGrant ? "Revoke free access" : "Grant free access"}
              </button>

              <div className="flex flex-wrap gap-2">
                {detail.stripeLinks.customer ? (
                  <a
                    href={detail.stripeLinks.customer}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 text-xs rounded bg-accent/15 text-accent hover:bg-accent/20 transition-colors"
                  >
                    Open Customer in Stripe
                  </a>
                ) : null}
                {detail.stripeLinks.subscription ? (
                  <a
                    href={detail.stripeLinks.subscription}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 text-xs rounded bg-accent/15 text-accent hover:bg-accent/20 transition-colors"
                  >
                    Open Subscription in Stripe
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </DetailCard>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <DetailCard title="Auth Accounts">
            {detail.accounts.length === 0 ? (
              <p className="text-xs text-muted">No accounts</p>
            ) : (
              <div className="divide-y divide-border/50">
                {detail.accounts.map((account) => (
                  <div key={account.id} className="py-3 first:pt-0 last:pb-0 text-xs space-y-1">
                    <div className="font-medium text-foreground">{account.auth_provider}</div>
                    <div className="text-muted">{account.email ?? account.provider_account_id}</div>
                    <div className="text-dim">{formatTimestamp(account.created_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </DetailCard>

          <DetailCard title="Data Providers">
            {detail.providers.length === 0 ? (
              <p className="text-xs text-muted">No providers</p>
            ) : (
              <div className="divide-y divide-border/50">
                {detail.providers.map((provider) => (
                  <div key={provider.id} className="py-3 first:pt-0 last:pb-0 text-xs space-y-1">
                    <div className="font-medium text-foreground">{provider.name}</div>
                    <div className="text-muted font-mono">{provider.id}</div>
                    <div className="text-dim">{formatTimestamp(provider.created_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </DetailCard>

          <DetailCard title="Recent Sessions">
            {detail.sessions.length === 0 ? (
              <p className="text-xs text-muted">No sessions</p>
            ) : (
              <div className="divide-y divide-border/50">
                {detail.sessions.map((session) => (
                  <div key={session.id} className="py-3 first:pt-0 last:pb-0 text-xs space-y-1">
                    <div className="font-mono text-muted">{session.id}</div>
                    <div className="text-dim">Created: {formatTimestamp(session.created_at)}</div>
                    <div className="text-dim">Expires: {formatTimestamp(session.expires_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </DetailCard>
        </div>
      </div>
    </PageLayout>
  );
}

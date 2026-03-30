import { useEffect, useState } from "react";
import type { ConfiguredProviders } from "../lib/auth.ts";
import { fetchConfiguredProviders } from "../lib/auth.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";
import { ProviderLogo, providerLabel } from "./ProviderLogo.tsx";

export function LinkedAccountsPanel() {
  const linkedAccounts = trpc.auth.linkedAccounts.useQuery();
  const unlinkMutation = trpc.auth.unlinkAccount.useMutation({
    onSuccess: () => linkedAccounts.refetch(),
  });

  const [availableProviders, setAvailableProviders] = useState<ConfiguredProviders | null>(null);
  useEffect(() => {
    fetchConfiguredProviders()
      .then(setAvailableProviders)
      .catch((error: unknown) =>
        captureException(error, { context: "fetch-configured-providers" }),
      );
  }, []);

  if (linkedAccounts.isLoading) {
    return <p className="text-sm text-subtle">Loading linked accounts...</p>;
  }

  const accounts = linkedAccounts.data ?? [];
  const linkedProviderIds = new Set(accounts.map((a) => a.authProvider));

  // Providers available to link (not already linked)
  const unlinkableIdentity = (availableProviders?.identity ?? []).filter(
    (id) => !linkedProviderIds.has(id),
  );
  const unlinkableData = (availableProviders?.data ?? []).filter(
    (id) => !linkedProviderIds.has(id),
  );
  const canAddMore = unlinkableIdentity.length > 0 || unlinkableData.length > 0;

  return (
    <div className="space-y-4">
      {accounts.length === 0 ? (
        <p className="text-sm text-subtle">No linked accounts</p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between py-2 px-3 rounded bg-surface-hover"
            >
              <div className="flex items-center gap-3">
                <ProviderLogo provider={account.authProvider} size={28} />
                <div>
                  <p className="text-sm text-foreground">{providerLabel(account.authProvider)}</p>
                  {account.email && <p className="text-xs text-subtle">{account.email}</p>}
                </div>
              </div>
              <button
                type="button"
                disabled={accounts.length < 2 || unlinkMutation.isPending}
                onClick={() => unlinkMutation.mutate({ accountId: account.id })}
                className="text-xs text-red-400 hover:text-red-300 disabled:text-dim disabled:cursor-not-allowed transition-colors cursor-pointer"
                title={
                  accounts.length < 2
                    ? "Cannot unlink your only login method"
                    : "Unlink this account"
                }
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}

      {canAddMore && (
        <div>
          <h3 className="text-xs font-medium text-subtle uppercase mb-2">Add Login Method</h3>
          <div className="flex flex-wrap gap-2">
            {unlinkableIdentity.map((id) => (
              <a
                key={id}
                href={`/auth/link/${id}`}
                className="text-xs px-3 py-1.5 rounded bg-accent/10 hover:bg-surface-hover border border-border-strong hover:border-border-strong text-foreground transition-colors"
              >
                {providerLabel(id)}
              </a>
            ))}
            {unlinkableData.map((id) => (
              <a
                key={id}
                href={`/auth/link/data/${id}`}
                className="text-xs px-3 py-1.5 rounded bg-accent/10 hover:bg-surface-hover border border-border-strong hover:border-border-strong text-foreground transition-colors"
              >
                {providerLabel(id)}
              </a>
            ))}
          </div>
        </div>
      )}

      {unlinkMutation.error && (
        <p className="text-xs text-red-400">{unlinkMutation.error.message}</p>
      )}
    </div>
  );
}

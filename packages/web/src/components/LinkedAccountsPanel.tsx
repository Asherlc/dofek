import { useEffect, useState } from "react";
import type { ConfiguredProviders } from "../lib/auth.ts";
import { fetchConfiguredProviders } from "../lib/auth.ts";
import { trpc } from "../lib/trpc.ts";

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
  authentik: "Homelab",
  strava: "Strava",
  wahoo: "Wahoo",
  fitbit: "Fitbit",
  "ride-with-gps": "Ride with GPS",
  withings: "Withings",
  garmin: "Garmin",
  polar: "Polar",
};

export function LinkedAccountsPanel() {
  const linkedAccounts = trpc.auth.linkedAccounts.useQuery();
  const unlinkMutation = trpc.auth.unlinkAccount.useMutation({
    onSuccess: () => linkedAccounts.refetch(),
  });

  const [availableProviders, setAvailableProviders] = useState<ConfiguredProviders | null>(null);
  useEffect(() => {
    fetchConfiguredProviders()
      .then(setAvailableProviders)
      .catch(() => {});
  }, []);

  if (linkedAccounts.isLoading) {
    return <p className="text-sm text-zinc-500">Loading linked accounts...</p>;
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
        <p className="text-sm text-zinc-500">No linked accounts</p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between py-2 px-3 rounded bg-zinc-800/50"
            >
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-zinc-700 text-zinc-300 text-sm font-medium">
                  {(PROVIDER_LABELS[account.authProvider] ??
                    account.authProvider)[0]?.toUpperCase()}
                </span>
                <div>
                  <p className="text-sm text-zinc-200">
                    {PROVIDER_LABELS[account.authProvider] ?? account.authProvider}
                  </p>
                  {account.email && <p className="text-xs text-zinc-500">{account.email}</p>}
                </div>
              </div>
              <button
                type="button"
                disabled={accounts.length < 2 || unlinkMutation.isPending}
                onClick={() => unlinkMutation.mutate({ accountId: account.id })}
                className="text-xs text-red-400 hover:text-red-300 disabled:text-zinc-600 disabled:cursor-not-allowed transition-colors cursor-pointer"
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
          <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Add Login Method</h3>
          <div className="flex flex-wrap gap-2">
            {unlinkableIdentity.map((id) => (
              <a
                key={id}
                href={`/auth/link/${id}`}
                className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-600 text-zinc-300 transition-colors"
              >
                {PROVIDER_LABELS[id] ?? id}
              </a>
            ))}
            {unlinkableData.map((id) => (
              <a
                key={id}
                href={`/auth/link/data/${id}`}
                className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-600 text-zinc-300 transition-colors"
              >
                {PROVIDER_LABELS[id] ?? id}
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

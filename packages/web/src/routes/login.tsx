import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ProviderLogo, providerLabel } from "../components/ProviderLogo.tsx";
import type { ConfiguredProviders } from "../lib/auth.ts";
import { fetchConfiguredProviders } from "../lib/auth.ts";

function LoginPage() {
  const { onboarding } = useSearch({ from: "__root__" });
  const [providers, setProviders] = useState<ConfiguredProviders | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchConfiguredProviders()
      .then(setProviders)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load providers");
      })
      .finally(() => setLoading(false));
  }, []);

  const allProviders = providers
    ? [
        ...providers.identity.map((id) => ({ id, type: "identity" as const })),
        ...providers.data.map((id) => ({ id, type: "data" as const })),
      ]
    : [];
  const returnTo = onboarding ? "/dashboard?onboarding=true" : undefined;
  const returnToQuery = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="w-full max-w-sm p-8 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-xl">
        <h1 className="text-2xl font-bold text-zinc-100 text-center mb-2">Dofek</h1>
        <p className="text-zinc-400 text-center mb-8 text-sm">Sign in to view your health data</p>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-zinc-600 border-t-emerald-500 rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="text-center">
            <p className="text-red-400 text-sm mb-2">Unable to connect to server</p>
            <p className="text-zinc-500 text-xs">{error}</p>
          </div>
        ) : allProviders.length === 0 ? (
          <p className="text-zinc-500 text-center text-sm">No login providers configured.</p>
        ) : (
          <div className="space-y-3">
            {allProviders.map(({ id, type }) => (
              <a
                key={id}
                href={
                  type === "identity"
                    ? `/auth/login/${id}${returnToQuery}`
                    : `/auth/login/data/${id}${returnToQuery}`
                }
                className="flex items-center justify-center gap-3 w-full px-4 py-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-600 text-zinc-200 transition-colors text-sm font-medium"
              >
                <ProviderLogo provider={id} size={20} />
                Sign in with {providerLabel(id)}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

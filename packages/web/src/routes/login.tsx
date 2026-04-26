import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ProviderLogo, providerLabel } from "../components/ProviderLogo.tsx";
import type { ConfiguredProviders } from "../lib/auth.ts";
import { fetchConfiguredProviders } from "../lib/auth.ts";

function LoginPage() {
  const { providerGuide } = useSearch({ from: "__root__" });
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
  const returnTo = providerGuide ? "/dashboard?providerGuide=true" : undefined;
  const returnToQuery = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";

  return (
    <div className="min-h-screen bg-page flex items-center justify-center">
      <div className="w-full max-w-sm p-8 rounded-2xl bg-surface-solid border border-border shadow-xl">
        <h1 className="text-2xl font-bold text-foreground text-center mb-2">Dofek</h1>
        <p className="text-muted text-center mb-8 text-sm">Sign in to view your health data</p>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="text-center">
            <p className="text-red-400 text-sm mb-2">Unable to connect to server</p>
            <p className="text-subtle text-xs">{error}</p>
          </div>
        ) : allProviders.length === 0 ? (
          <p className="text-subtle text-center text-sm">No login providers configured.</p>
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
                className="flex items-center justify-center gap-3 w-full px-4 py-3 rounded-lg bg-accent/10 hover:bg-surface-hover border border-border-strong hover:border-border-strong text-foreground transition-colors text-sm font-medium"
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

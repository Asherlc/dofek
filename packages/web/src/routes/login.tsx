import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { IdentityProviderName } from "../lib/auth.ts";
import { fetchConfiguredProviders } from "../lib/auth.ts";

const providerLabels: Record<IdentityProviderName, string> = {
  google: "Google",
  apple: "Apple",
  authentik: "Authentik",
};

const providerIcons: Record<IdentityProviderName, string> = {
  google: "G",
  apple: "\uF8FF",
  authentik: "A",
};

function LoginPage() {
  const [providers, setProviders] = useState<IdentityProviderName[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchConfiguredProviders()
      .then(setProviders)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="w-full max-w-sm p-8 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-xl">
        <h1 className="text-2xl font-bold text-zinc-100 text-center mb-2">Dofek</h1>
        <p className="text-zinc-400 text-center mb-8 text-sm">Sign in to view your health data</p>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-zinc-600 border-t-emerald-500 rounded-full animate-spin" />
          </div>
        ) : providers.length === 0 ? (
          <p className="text-zinc-500 text-center text-sm">
            No identity providers configured. Set environment variables for Google, Apple, or
            Authentik.
          </p>
        ) : (
          <div className="space-y-3">
            {providers.map((name) => (
              <a
                key={name}
                href={`/auth/login/${name}`}
                className="flex items-center justify-center gap-3 w-full px-4 py-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-600 text-zinc-200 transition-colors text-sm font-medium"
              >
                <span className="text-lg leading-none">{providerIcons[name]}</span>
                Sign in with {providerLabels[name]}
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

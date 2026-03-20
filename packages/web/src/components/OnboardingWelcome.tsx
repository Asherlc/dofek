import { ONBOARDING_CATEGORIES } from "@dofek/onboarding/onboarding";
import { Link } from "@tanstack/react-router";
import { ProviderLogo, providerLabel } from "./ProviderLogo.tsx";

interface ProviderInfo {
  id: string;
  name: string;
  authorized: boolean;
}

interface OnboardingWelcomeProps {
  onDismiss: () => void;
  providers: ProviderInfo[];
}

export function OnboardingWelcome({ onDismiss, providers }: OnboardingWelcomeProps) {
  const availableProviderIds = new Set(providers.map((p) => p.id));

  return (
    <div className="space-y-6" data-testid="onboarding-welcome">
      {/* Welcome header */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 sm:p-8 text-center">
        <h1 className="text-2xl sm:text-3xl font-bold text-zinc-100 mb-2">Welcome to Dofek</h1>
        <p className="text-zinc-400 max-w-xl mx-auto">
          Connect your health and fitness accounts to unlock personalized insights, recovery
          tracking, training analysis, and more.
        </p>
      </div>

      {/* Category cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {ONBOARDING_CATEGORIES.map((category) => {
          // Only show providers that are actually available on this server
          const categoryProviders = category.providerIds.filter((id) =>
            availableProviderIds.has(id),
          );
          if (categoryProviders.length === 0) return null;

          return (
            <div
              key={category.title}
              className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 flex flex-col gap-3"
            >
              <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wider">
                {category.title}
              </h3>
              <p className="text-sm text-zinc-500 flex-1">{category.description}</p>
              <div className="flex items-center gap-2 flex-wrap">
                {categoryProviders.slice(0, 5).map((providerId) => (
                  <div key={providerId} className="flex items-center gap-1.5">
                    <ProviderLogo provider={providerId} size={18} />
                    <span className="text-xs text-zinc-400">{providerLabel(providerId)}</span>
                  </div>
                ))}
                {categoryProviders.length > 5 && (
                  <span className="text-xs text-zinc-500">
                    +{categoryProviders.length - 5} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-center gap-4">
        <Link
          to="/providers"
          className="inline-flex items-center px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
        >
          Set up data sources
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

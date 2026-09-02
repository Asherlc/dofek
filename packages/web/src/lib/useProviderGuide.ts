import { shouldShowProviderGuide } from "@dofek/onboarding/provider-guide";
import { useSearch } from "@tanstack/react-router";
import { trpc } from "./trpc.ts";

export function useProviderGuide() {
  const { providerGuide: forceProviderGuide } = useSearch({ from: "__root__" });
  const providers = trpc.sync.providers.useQuery();
  const status = trpc.providerGuide.status.useQuery();
  const dismissMutation = trpc.providerGuide.dismiss.useMutation();
  const trpcUtils = trpc.useUtils();

  const connectedCount = (providers.data ?? []).filter(
    (provider) => provider.authorized && !provider.importOnly,
  ).length;
  const guideProviders = (providers.data ?? []).filter(
    (provider) => provider.importOnly || provider.authType !== "none",
  );
  const dismissed = status.data?.dismissed === true;
  const isLoading = providers.isLoading || status.isLoading;
  const hasProviderInventory = providers.data !== undefined;
  const hasDismissalStatus = status.data !== undefined;

  const showProviderGuide =
    (forceProviderGuide && hasProviderInventory) ||
    (!isLoading &&
      hasProviderInventory &&
      hasDismissalStatus &&
      shouldShowProviderGuide(connectedCount, dismissed));

  function dismiss() {
    dismissMutation.mutate(undefined, {
      onSuccess: () => {
        trpcUtils.providerGuide.status.invalidate();
      },
    });
  }

  return {
    showProviderGuide,
    dismiss,
    error: providers.error ?? status.error,
    isLoading,
    providers: guideProviders,
  };
}

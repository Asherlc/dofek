import { shouldShowProviderGuide } from "@dofek/onboarding/provider-guide";
import { trpc } from "./trpc";

export function useProviderGuide() {
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

  const showProviderGuide = !isLoading && shouldShowProviderGuide(connectedCount, dismissed);

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
    isLoading,
    providers: guideProviders,
  };
}

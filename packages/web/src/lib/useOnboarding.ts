import { ONBOARDING_SETTINGS_KEY, shouldShowOnboarding } from "@dofek/onboarding/onboarding";
import { useSearch } from "@tanstack/react-router";
import { trpc } from "./trpc.ts";

export function useOnboarding() {
  const { onboarding: forceOnboarding } = useSearch({ from: "__root__" });
  const providers = trpc.sync.providers.useQuery();
  const dismissedSetting = trpc.settings.get.useQuery({ key: ONBOARDING_SETTINGS_KEY });
  const setMutation = trpc.settings.set.useMutation();
  const trpcUtils = trpc.useUtils();

  const connectedCount = (providers.data ?? []).filter((p) => p.authorized && !p.importOnly).length;
  const dismissed = dismissedSetting.data?.value === true;
  const isLoading = providers.isLoading || dismissedSetting.isLoading;

  const showOnboarding =
    forceOnboarding || (!isLoading && shouldShowOnboarding(connectedCount, dismissed));

  function dismiss() {
    setMutation.mutate(
      { key: ONBOARDING_SETTINGS_KEY, value: true },
      {
        onSuccess: () => {
          trpcUtils.settings.get.invalidate({ key: ONBOARDING_SETTINGS_KEY });
        },
      },
    );
  }

  return {
    showOnboarding,
    dismiss,
    isLoading,
    providers: providers.data ?? [],
  };
}

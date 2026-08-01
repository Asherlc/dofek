import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { isSettingsTab, type SettingsTab } from "../pages/settingsTabs.ts";

export const Route = createFileRoute("/settings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab?: SettingsTab;
    zeppPair?: string;
  } => ({
    ...(isSettingsTab(search.tab) ? { tab: search.tab } : {}),
    ...(typeof search.zeppPair === "string" && search.zeppPair.length > 0
      ? { zeppPair: search.zeppPair }
      : {}),
  }),
  component: SettingsPage,
});

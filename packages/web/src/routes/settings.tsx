import { createFileRoute } from "@tanstack/react-router";
import { isSettingsTab, SettingsPage } from "../pages/SettingsPage.tsx";

export const Route = createFileRoute("/settings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab?: "general" | "health" | "connections" | "account" | "advanced";
    zeppPair?: string;
  } => ({
    ...(isSettingsTab(search.tab) ? { tab: search.tab } : {}),
    ...(typeof search.zeppPair === "string" && search.zeppPair.length > 0
      ? { zeppPair: search.zeppPair }
      : {}),
  }),
  component: SettingsPage,
});

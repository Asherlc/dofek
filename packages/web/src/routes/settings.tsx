import { createFileRoute } from "@tanstack/react-router";
import { isSettingsCategory, SettingsPage } from "../pages/SettingsPage.tsx";

export const Route = createFileRoute("/settings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab?:
      | "account"
      | "data-sources"
      | "goals-models"
      | "privacy-export"
      | "notifications"
      | "billing"
      | "advanced";
    zeppPair?: string;
  } => ({
    ...(isSettingsCategory(search.tab) ? { tab: search.tab } : {}),
    ...(typeof search.zeppPair === "string" && search.zeppPair.length > 0
      ? { zeppPair: search.zeppPair }
      : {}),
  }),
  component: SettingsPage,
});

import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { normalizeSettingsCategory, type SettingsCategory } from "../pages/settingsCategories.ts";

export const Route = createFileRoute("/settings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab?: SettingsCategory;
  } => {
    const tab = normalizeSettingsCategory(search.tab);
    return {
      ...(tab ? { tab } : {}),
    };
  },
  component: SettingsPage,
});

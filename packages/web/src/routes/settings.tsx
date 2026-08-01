import { createFileRoute } from "@tanstack/react-router";
import {
  normalizeSettingsCategory,
  type SettingsCategory,
  SettingsPage,
} from "../pages/SettingsPage.tsx";

export const Route = createFileRoute("/settings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab?: SettingsCategory;
    zeppPair?: string;
  } => {
    const tab = normalizeSettingsCategory(search.tab);
    return {
      ...(tab ? { tab } : {}),
      ...(typeof search.zeppPair === "string" && search.zeppPair.length > 0
        ? { zeppPair: search.zeppPair }
        : {}),
    };
  },
  component: SettingsPage,
});

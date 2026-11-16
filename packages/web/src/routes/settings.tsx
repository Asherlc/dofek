import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { normalizeSettingsCategory, type SettingsCategory } from "../pages/settingsCategories.ts";

export const Route = createFileRoute("/settings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab?: SettingsCategory;
    section?: "cycling-ftp";
    date?: string;
  } => {
    const tab = normalizeSettingsCategory(search.tab);
    const section = search.section === "cycling-ftp" ? search.section : undefined;
    const date =
      typeof search.date === "string" && isDateYmd(search.date) ? search.date : undefined;
    return {
      ...(tab ? { tab } : {}),
      ...(section ? { section } : {}),
      ...(date ? { date } : {}),
    };
  },
  component: SettingsPage,
});

function isDateYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
